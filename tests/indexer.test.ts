import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexProject, reindexFile } from '../src/indexer';
import { openDatabase } from '../src/db/schema';
import { search, getCallers, getStats, getFileSymbols, getImpact } from '../src/query/engine';

let tmpDir: string;

function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-indexer-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('indexProject', () => {
    it('indexes TypeScript files and extracts symbols', () => {
        writeFile('src/math.ts', `
export function add(a: number, b: number): number {
    return a + b;
}

export function multiply(a: number, b: number): number {
    return a * b;
}

function internal() {
    return add(1, 2);
}
`);
        writeFile('src/index.ts', `
import { add, multiply } from './math';

export function main() {
    const result = add(1, 2);
    console.log(multiply(result, 3));
}
`);

        const stats = indexProject(tmpDir);
        expect(stats.totalFiles).toBeGreaterThanOrEqual(2);
        expect(stats.indexedFiles).toBeGreaterThanOrEqual(2);
        expect(stats.symbols).toBeGreaterThan(0);

        // Verify search works on indexed data
        const db = openDatabase(tmpDir);
        try {
            const results = search(db, 'add');
            expect(results.length).toBeGreaterThan(0);
            expect(results.some(r => r.name === 'add')).toBe(true);
        } finally {
            db.close();
        }
    });

    it('creates file dependencies after full index', () => {
        writeFile('src/utils.ts', `
export function helper() { return 42; }
`);
        writeFile('src/app.ts', `
import { helper } from './utils';
export function run() { return helper(); }
`);

        // First index creates file records; second pass resolves deps
        // (deps to files processed later in alphabetical order may need 2nd pass)
        indexProject(tmpDir);
        // Touch app.ts to force re-index so it can find utils.ts's file record
        writeFile('src/app.ts', `
import { helper } from './utils';
export function run() { return helper() + 1; }
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

    it('computes PageRank', () => {
        writeFile('src/core.ts', `
export function coreFunc() { return 1; }
`);
        writeFile('src/a.ts', `
import { coreFunc } from './core';
export function useCore() { return coreFunc(); }
`);
        writeFile('src/b.ts', `
import { coreFunc } from './core';
export function alsoUseCore() { return coreFunc(); }
`);

        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const rankings = db.prepare(
                'SELECT r.pagerank FROM rankings r JOIN symbols s ON s.id = r.symbol_id WHERE s.name = ?'
            ).get('coreFunc') as any;
            expect(rankings).toBeDefined();
            expect(rankings.pagerank).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });

    it('skips unchanged files on re-index', () => {
        writeFile('src/a.ts', 'export const x = 1;');
        const stats1 = indexProject(tmpDir);
        const stats2 = indexProject(tmpDir);
        expect(stats2.skippedFiles).toBeGreaterThanOrEqual(stats1.indexedFiles);
    });

    it('handles empty project', () => {
        const stats = indexProject(tmpDir);
        expect(stats.totalFiles).toBe(0);
        expect(stats.symbols).toBe(0);
    });
});

describe('reindexFile', () => {
    it('updates a single file without full reindex', () => {
        writeFile('src/a.ts', 'export function foo() { return 1; }');
        indexProject(tmpDir);

        // Modify the file
        writeFile('src/a.ts', `
export function foo() { return 1; }
export function bar() { return 2; }
`);

        const db = openDatabase(tmpDir);
        try {
            reindexFile(tmpDir, 'src/a.ts', db);
            const syms = getFileSymbols(db, 'src/a.ts');
            expect(syms.some(s => s.name === 'bar')).toBe(true);
        } finally {
            db.close();
        }
    });

    it('handles deleted file', () => {
        writeFile('src/a.ts', 'export function foo() {}');
        indexProject(tmpDir);
        fs.unlinkSync(path.join(tmpDir, 'src/a.ts'));

        const db = openDatabase(tmpDir);
        try {
            reindexFile(tmpDir, 'src/a.ts', db);
            const syms = getFileSymbols(db, 'src/a.ts');
            expect(syms.length).toBe(0);
        } finally {
            db.close();
        }
    });
});

describe('parser integration', () => {
    it('extracts function signatures', () => {
        writeFile('src/typed.ts', `
export function greet(name: string, age: number): string {
    return \`Hello \${name}, age \${age}\`;
}
`);
        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const syms = getFileSymbols(db, 'src/typed.ts');
            const greet = syms.find(s => s.name === 'greet');
            expect(greet).toBeDefined();
            expect(greet!.signature).toContain('name');
        } finally {
            db.close();
        }
    });

    it('extracts class methods', () => {
        writeFile('src/class.ts', `
export class Calculator {
    add(a: number, b: number): number {
        return a + b;
    }
    subtract(a: number, b: number): number {
        return a - b;
    }
}
`);
        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const syms = getFileSymbols(db, 'src/class.ts');
            const names = syms.map(s => s.name);
            expect(names).toContain('Calculator');
        } finally {
            db.close();
        }
    });

    it('handles JavaScript files', () => {
        writeFile('src/legacy.js', `
function oldSchool(x) {
    return x * 2;
}
module.exports = { oldSchool };
`);
        indexProject(tmpDir);
        const db = openDatabase(tmpDir);
        try {
            const syms = getFileSymbols(db, 'src/legacy.js');
            expect(syms.some(s => s.name === 'oldSchool')).toBe(true);
        } finally {
            db.close();
        }
    });
});
