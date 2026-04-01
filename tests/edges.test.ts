import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexProject } from '../src/indexer';
import { openDatabase } from '../src/db/schema';
import { getCallers, getStats, search, getContext, getDeps, getImpact, getFileSymbols } from '../src/query/engine';
import type Database from 'better-sqlite3';

let tmpDir: string;

function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-edges-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cross-file edge resolution', () => {
    it('creates reference edges only for symbols that use the import', () => {
        writeFile('src/math.ts', `
export function add(a: number, b: number): number {
    return a + b;
}
export function multiply(a: number, b: number): number {
    return a * b;
}
`);
        writeFile('src/app.ts', `
import { add } from './math';

export function useAdd() {
    return add(1, 2);
}

export function unrelated() {
    return 42;
}
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const callers = getCallers(db, 'add');
            const callerNames = callers.map(c => c.name);
            // useAdd calls add, so it should be a caller
            expect(callerNames).toContain('useAdd');
        } finally {
            db.close();
        }
    });

    it('does not create excessive edges (no edge explosion)', () => {
        // Create a file with many symbols importing one thing
        const funcs = Array.from({ length: 20 }, (_, i) =>
            `export function func${i}() { return ${i}; }`
        ).join('\n');

        writeFile('src/target.ts', `
export function targetFunc() { return 42; }
`);
        writeFile('src/importer.ts', `
import { targetFunc } from './target';
${funcs}
export function caller() { return targetFunc(); }
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const stats = getStats(db);
            // Should NOT have 20+ edges from all symbols to targetFunc
            // Should have at most a few (caller -> targetFunc, maybe one fallback)
            const edgeCount = (db.prepare(
                `SELECT COUNT(*) as c FROM edges e
                 JOIN symbols s ON s.id = e.to_id
                 WHERE s.name = 'targetFunc' AND e.kind = 'references'`
            ).get() as any).c;
            // With the fix: at most 1-2 reference edges (caller + maybe fallback)
            expect(edgeCount).toBeLessThanOrEqual(3);
        } finally {
            db.close();
        }
    });

    it('creates intra-file call edges with line numbers', () => {
        writeFile('src/a.ts', `
function helper() { return 1; }

export function main() {
    return helper();
}
`);
        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const edges = db.prepare(`
                SELECT e.line, s1.name as from_name, s2.name as to_name
                FROM edges e
                JOIN symbols s1 ON s1.id = e.from_id
                JOIN symbols s2 ON s2.id = e.to_id
                WHERE e.kind = 'calls'
            `).all() as { line: number; from_name: string; to_name: string }[];

            const mainToHelper = edges.find(e => e.from_name === 'main' && e.to_name === 'helper');
            expect(mainToHelper).toBeDefined();
            expect(mainToHelper!.line).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });

    it('creates file dependency edges', () => {
        writeFile('src/utils.ts', `
export function format(s: string): string { return s.trim(); }
`);
        writeFile('src/app.ts', `
import { format } from './utils';
export function run() { return format('hello'); }
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const deps = db.prepare(`
                SELECT f1.path as from_path, f2.path as to_path
                FROM file_deps fd
                JOIN files f1 ON f1.id = fd.from_file
                JOIN files f2 ON f2.id = fd.to_file
            `).all() as { from_path: string; to_path: string }[];

            expect(deps.some(d => d.from_path === 'src/app.ts' && d.to_path === 'src/utils.ts')).toBe(true);
        } finally {
            db.close();
        }
    });

    it('tracks package dependencies', () => {
        writeFile('src/server.ts', `
import express from 'express';
import { Router } from 'express';

export function createServer() {
    const app = express();
    return app;
}
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const pkgDeps = db.prepare(
                'SELECT package, imported_names FROM pkg_deps'
            ).all() as { package: string; imported_names: string }[];

            expect(pkgDeps.some(d => d.package === 'express')).toBe(true);
        } finally {
            db.close();
        }
    });

    it('handles diamond import pattern', () => {
        writeFile('src/base.ts', `
export function base() { return 1; }
`);
        writeFile('src/left.ts', `
import { base } from './base';
export function left() { return base() + 1; }
`);
        writeFile('src/right.ts', `
import { base } from './base';
export function right() { return base() + 2; }
`);
        writeFile('src/top.ts', `
import { left } from './left';
import { right } from './right';
export function top() { return left() + right(); }
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            // base should be called by both left and right
            const baseCallers = getCallers(db, 'base');
            const names = baseCallers.map(c => c.name);
            expect(names).toContain('left');
            expect(names).toContain('right');

            // Impact of base.ts should propagate through diamond
            const impact = getImpact(db, 'src/base.ts');
            const impactFiles = impact.map(i => i.file);
            expect(impactFiles).toContain('src/left.ts');
            expect(impactFiles).toContain('src/right.ts');
            expect(impactFiles).toContain('src/top.ts');
        } finally {
            db.close();
        }
    });

    it('resolves index file imports', () => {
        writeFile('src/utils/index.ts', `
export function helper() { return 42; }
`);
        writeFile('src/app.ts', `
import { helper } from './utils';
export function run() { return helper(); }
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const deps = db.prepare(`
                SELECT f1.path as from_path, f2.path as to_path
                FROM file_deps fd
                JOIN files f1 ON f1.id = fd.from_file
                JOIN files f2 ON f2.id = fd.to_file
            `).all() as { from_path: string; to_path: string }[];

            expect(deps.some(d =>
                d.from_path === 'src/app.ts' && d.to_path === 'src/utils/index.ts'
            )).toBe(true);
        } finally {
            db.close();
        }
    });

    it('handles re-exports in barrel files', () => {
        writeFile('src/math.ts', `
export function add(a: number, b: number) { return a + b; }
export function sub(a: number, b: number) { return a - b; }
`);
        writeFile('src/index.ts', `
export { add, sub } from './math';
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const syms = getFileSymbols(db, 'src/index.ts');
            const names = syms.map(s => s.name);
            // Re-export pseudo-symbols should exist
            expect(names).toContain('add');
            expect(names).toContain('sub');
        } finally {
            db.close();
        }
    });
});

describe('PageRank correctness', () => {
    it('assigns higher rank to more-referenced symbols', () => {
        writeFile('src/core.ts', `
export function core() { return 1; }
`);
        writeFile('src/a.ts', `
import { core } from './core';
export function a() { return core(); }
`);
        writeFile('src/b.ts', `
import { core } from './core';
export function b() { return core(); }
`);
        writeFile('src/c.ts', `
import { core } from './core';
export function c() { return core(); }
`);
        writeFile('src/leaf.ts', `
export function leaf() { return 999; }
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const coreRank = db.prepare(
                'SELECT r.pagerank FROM rankings r JOIN symbols s ON s.id = r.symbol_id WHERE s.name = ?'
            ).get('core') as any;
            const leafRank = db.prepare(
                'SELECT r.pagerank FROM rankings r JOIN symbols s ON s.id = r.symbol_id WHERE s.name = ?'
            ).get('leaf') as any;

            expect(coreRank.pagerank).toBeGreaterThan(leafRank.pagerank);
        } finally {
            db.close();
        }
    });

    it('PageRank sums to approximately 1', () => {
        writeFile('src/a.ts', `
export function a() { return 1; }
export function b() { return 2; }
`);
        writeFile('src/c.ts', `
import { a } from './a';
export function c() { return a(); }
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const sum = (db.prepare('SELECT SUM(pagerank) as total FROM rankings').get() as any).total;
            expect(sum).toBeGreaterThan(0.9);
            expect(sum).toBeLessThan(1.1);
        } finally {
            db.close();
        }
    });
});

describe('large file skip', () => {
    it('skips files larger than MAX_FILE_SIZE during indexing', () => {
        writeFile('src/small.ts', 'export const x = 1;');
        // Create a file >512KB
        const bigContent = 'export const x = ' + 'a'.repeat(600 * 1024) + ';';
        writeFile('src/big.ts', bigContent);

        const stats = indexProject(tmpDir);
        expect(stats.indexedFiles).toBe(1);
        expect(stats.skippedFiles).toBe(1);

        const db = openDatabase(tmpDir);
        try {
            const syms = getFileSymbols(db, 'src/big.ts');
            expect(syms.length).toBe(0);
        } finally {
            db.close();
        }
    });
});
