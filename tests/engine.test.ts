import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, getOrCreateFile, insertSymbol, insertEdge, insertFileDep, insertPkgDep, insertTypeRelation } from '../src/db/schema';
import {
    search, getCallers, getContext, getImpact, getDeps, getRank,
    getModules, getStats, findFiles, getFileMap, getFileMapCompact,
    getFileSymbols, findByKind, getTypeHierarchy, findDeadExports, getPkgUsages,
} from '../src/query/engine';
import type Database from 'better-sqlite3';

let tmpDir: string;
let db: Database.Database;

// Helper: seed a realistic mini-codebase into the DB
function seedTestData() {
    const f1 = getOrCreateFile(db, 'src/utils.ts', 'h1', 'typescript', 20);
    const f2 = getOrCreateFile(db, 'src/index.ts', 'h2', 'typescript', 50);
    const f3 = getOrCreateFile(db, 'src/api/handler.ts', 'h3', 'typescript', 100);
    const f4 = getOrCreateFile(db, 'package.json', 'h4', null, 30);

    // utils.ts — formatDate (exported), helper (internal)
    const formatDate = insertSymbol(db, f1.id, {
        name: 'formatDate', kind: 'function', lineStart: 1, lineEnd: 10,
        signature: 'function formatDate(d: Date): string', exported: true,
        content: 'function formatDate(d: Date): string { return d.toISOString(); }',
    });
    const helper = insertSymbol(db, f1.id, {
        name: 'helper', kind: 'function', lineStart: 12, lineEnd: 15,
        signature: 'function helper(): void', exported: false,
    });

    // index.ts — main (exported), uses formatDate
    const main = insertSymbol(db, f2.id, {
        name: 'main', kind: 'function', lineStart: 1, lineEnd: 30,
        signature: 'function main(): void', exported: true,
        content: 'function main() { formatDate(new Date()); }',
    });
    insertEdge(db, main, formatDate, 'calls');
    insertFileDep(db, f2.id, f1.id, 'import', 'formatDate');

    // handler.ts — handleRequest (exported), calls main and formatDate
    const handleRequest = insertSymbol(db, f3.id, {
        name: 'handleRequest', kind: 'function', lineStart: 5, lineEnd: 40,
        signature: 'async function handleRequest(req: Request): Promise<Response>',
        exported: true,
        content: 'async function handleRequest(req) { main(); formatDate(new Date()); }',
    });
    insertEdge(db, handleRequest, main, 'calls');
    insertEdge(db, handleRequest, formatDate, 'references');
    insertFileDep(db, f3.id, f2.id, 'import', 'main');
    insertFileDep(db, f3.id, f1.id, 'import', 'formatDate');

    // Type relation
    const MyClass = insertSymbol(db, f3.id, {
        name: 'MyClass', kind: 'class', lineStart: 50, lineEnd: 80,
        exported: true,
    });
    insertTypeRelation(db, MyClass, 'BaseClass', 'extends');

    // Package dep
    insertPkgDep(db, f3.id, 'express', 'Router');

    // PageRank
    db.prepare('DELETE FROM rankings').run();
    db.prepare('INSERT INTO rankings (symbol_id, pagerank, in_degree, out_degree) VALUES (?, ?, ?, ?)').run(formatDate, 0.25, 2, 0);
    db.prepare('INSERT INTO rankings (symbol_id, pagerank, in_degree, out_degree) VALUES (?, ?, ?, ?)').run(main, 0.15, 1, 1);
    db.prepare('INSERT INTO rankings (symbol_id, pagerank, in_degree, out_degree) VALUES (?, ?, ?, ?)').run(handleRequest, 0.10, 0, 2);
    db.prepare('INSERT INTO rankings (symbol_id, pagerank, in_degree, out_degree) VALUES (?, ?, ?, ?)').run(helper, 0.02, 0, 0);
    db.prepare('INSERT INTO rankings (symbol_id, pagerank, in_degree, out_degree) VALUES (?, ?, ?, ?)').run(MyClass, 0.05, 0, 0);

    return { f1, f2, f3, f4, formatDate, helper, main, handleRequest, MyClass };
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-engine-test-'));
    db = openDatabase(tmpDir);
});

afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('search', () => {
    it('finds symbols by name', () => {
        seedTestData();
        const results = search(db, 'formatDate');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe('formatDate');
    });

    it('ranks by pagerank', () => {
        seedTestData();
        const results = search(db, 'function');
        // formatDate has highest pagerank (0.25)
        expect(results[0].name).toBe('formatDate');
    });

    it('returns empty for no match', () => {
        seedTestData();
        const results = search(db, 'xyznonexistent');
        expect(results.length).toBe(0);
    });

    it('returns empty for empty query', () => {
        expect(search(db, '')).toEqual([]);
        expect(search(db, '   ')).toEqual([]);
    });

    it('handles special characters in query', () => {
        seedTestData();
        const results = search(db, 'format.Date::get');
        // Should not throw, special chars are stripped
        expect(Array.isArray(results)).toBe(true);
    });

    it('respects limit', () => {
        seedTestData();
        const results = search(db, 'function', 1);
        expect(results.length).toBeLessThanOrEqual(1);
    });
});

describe('getCallers', () => {
    it('finds all callers of a function', () => {
        seedTestData();
        const callers = getCallers(db, 'formatDate');
        const names = callers.map(c => c.name);
        expect(names).toContain('main');
        expect(names).toContain('handleRequest');
    });

    it('returns empty for uncalled function', () => {
        seedTestData();
        const callers = getCallers(db, 'helper');
        expect(callers.length).toBe(0);
    });
});

describe('getContext', () => {
    it('returns full context for a symbol', () => {
        seedTestData();
        const ctx = getContext(db, 'formatDate');
        expect(ctx).not.toBeNull();
        expect(ctx!.symbol.name).toBe('formatDate');
        expect(ctx!.symbol.kind).toBe('function');
        expect(ctx!.symbol.signature).toContain('formatDate');
        expect(ctx!.dependents.length).toBeGreaterThan(0);
    });

    it('includes same-file siblings', () => {
        seedTestData();
        const ctx = getContext(db, 'formatDate');
        expect(ctx!.sameFileSymbols.some(s => s.name === 'helper')).toBe(true);
    });

    it('returns null for unknown symbol', () => {
        seedTestData();
        expect(getContext(db, 'doesNotExist')).toBeNull();
    });

    it('prefers exported symbols over internal ones', () => {
        seedTestData();
        const ctx = getContext(db, 'formatDate');
        expect(ctx!.symbol.file).toBe('src/utils.ts');
    });
});

describe('getImpact', () => {
    it('finds transitive dependents of a file', () => {
        seedTestData();
        const impact = getImpact(db, 'src/utils.ts');
        const files = impact.map(i => i.file);
        expect(files).toContain('src/index.ts');
        expect(files).toContain('src/api/handler.ts');
    });

    it('reports correct depth', () => {
        seedTestData();
        const impact = getImpact(db, 'src/utils.ts');
        const indexTs = impact.find(i => i.file === 'src/index.ts');
        expect(indexTs?.depth).toBe(1);
    });

    it('returns empty for file with no dependents', () => {
        seedTestData();
        const impact = getImpact(db, 'src/api/handler.ts');
        expect(impact.length).toBe(0);
    });
});

describe('getDeps', () => {
    it('finds what a symbol depends on', () => {
        seedTestData();
        const deps = getDeps(db, 'main');
        expect(deps.some(d => d.name === 'formatDate')).toBe(true);
    });
});

describe('getRank', () => {
    it('returns symbols ordered by pagerank', () => {
        seedTestData();
        const ranked = getRank(db, 5);
        expect(ranked.length).toBeGreaterThan(0);
        // First should have highest pagerank
        for (let i = 1; i < ranked.length; i++) {
            expect(ranked[i - 1].pagerank).toBeGreaterThanOrEqual(ranked[i].pagerank);
        }
    });
});

describe('getModules', () => {
    it('groups files into modules', () => {
        seedTestData();
        const modules = getModules(db);
        const names = modules.map(m => m.name);
        expect(names).toContain('src');
    });

    it('tracks cross-module imports', () => {
        seedTestData();
        const modules = getModules(db);
        const srcMod = modules.find(m => m.name === 'src');
        expect(srcMod).toBeDefined();
        expect(srcMod!.symbolCount).toBeGreaterThan(0);
    });
});

describe('getStats', () => {
    it('returns correct counts', () => {
        seedTestData();
        const stats = getStats(db);
        expect(stats.files).toBe(4);
        expect(stats.symbols).toBe(5);
        expect(stats.edges).toBe(3); // main->formatDate, handleRequest->main, handleRequest->formatDate
        expect(stats.fileDeps).toBeGreaterThan(0);
    });

    it('returns zeros for empty DB', () => {
        const stats = getStats(db);
        expect(stats.files).toBe(0);
        expect(stats.symbols).toBe(0);
    });
});

describe('findFiles', () => {
    it('finds files by glob pattern', () => {
        seedTestData();
        const results = findFiles(db, '*.ts');
        expect(results.length).toBeGreaterThan(0);
        expect(results.every(r => r.path.endsWith('.ts'))).toBe(true);
    });

    it('finds files in subdirectory', () => {
        seedTestData();
        const results = findFiles(db, 'src/api/*');
        expect(results.length).toBe(1);
        expect(results[0].path).toBe('src/api/handler.ts');
    });

    it('returns empty for non-matching pattern', () => {
        seedTestData();
        expect(findFiles(db, '*.xyz').length).toBe(0);
    });
});

describe('getFileMap', () => {
    it('returns all files with their exports', () => {
        seedTestData();
        const map = getFileMap(db);
        expect(map.length).toBeGreaterThan(0);
        const utils = map.find(f => f.path === 'src/utils.ts');
        expect(utils).toBeDefined();
        expect(utils!.exports.some(e => e.includes('formatDate'))).toBe(true);
    });
});

describe('getFileMapCompact', () => {
    it('returns a markdown-formatted string', () => {
        seedTestData();
        const compact = getFileMapCompact(db);
        expect(compact).toContain('src/utils.ts');
        expect(compact).toContain('formatDate');
    });
});

describe('getFileSymbols', () => {
    it('returns all symbols in a file', () => {
        seedTestData();
        const syms = getFileSymbols(db, 'src/utils.ts');
        expect(syms.length).toBe(2);
        expect(syms[0].name).toBe('formatDate');
        expect(syms[1].name).toBe('helper');
    });

    it('returns empty for unknown file', () => {
        expect(getFileSymbols(db, 'nonexistent.ts').length).toBe(0);
    });
});

describe('findByKind', () => {
    it('finds all functions', () => {
        seedTestData();
        const fns = findByKind(db, 'function');
        expect(fns.length).toBe(4); // formatDate, helper, main, handleRequest
    });

    it('finds all classes', () => {
        seedTestData();
        const classes = findByKind(db, 'class');
        expect(classes.length).toBe(1);
        expect(classes[0].name).toBe('MyClass');
    });
});

describe('getTypeHierarchy', () => {
    it('finds subclasses of a base', () => {
        seedTestData();
        const hierarchy = getTypeHierarchy(db, 'BaseClass');
        expect(hierarchy.length).toBe(1);
        expect(hierarchy[0].name).toBe('MyClass');
        expect(hierarchy[0].relationKind).toBe('extends');
    });

    it('returns empty for unknown parent', () => {
        seedTestData();
        expect(getTypeHierarchy(db, 'NoSuchClass').length).toBe(0);
    });
});

describe('findDeadExports', () => {
    it('finds exported symbols with no references', () => {
        seedTestData();
        const dead = findDeadExports(db);
        // MyClass is exported but nothing references it via edges
        const names = dead.map(d => d.name);
        expect(names).toContain('MyClass');
    });
});

describe('getPkgUsages', () => {
    it('finds files using a package', () => {
        seedTestData();
        const usages = getPkgUsages(db, 'express');
        expect(usages.length).toBe(1);
        expect(usages[0].file).toBe('src/api/handler.ts');
    });

    it('returns empty for unused package', () => {
        seedTestData();
        expect(getPkgUsages(db, 'nonexistent-pkg').length).toBe(0);
    });
});
