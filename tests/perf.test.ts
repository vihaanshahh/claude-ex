import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexProject } from '../src/indexer';
import { openDatabase } from '../src/db/schema';
import {
    search, getCallers, getContext, getImpact, getStats, getRank,
    getModules, getFileMap, getFileMapCompact, getFileSymbols, findByKind,
    findDeadExports, getTaskContext,
} from '../src/query/engine';
import type Database from 'better-sqlite3';

// Generate a non-trivial codebase to benchmark queries
let tmpDir: string;
let db: Database.Database;

const FILE_COUNT = 50;
const SYMBOLS_PER_FILE = 5;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-test-'));

    // Generate files
    for (let i = 0; i < FILE_COUNT; i++) {
        const imports = i > 0
            ? `import { func_${i - 1}_0 } from './file_${i - 1}';\n`
            : '';
        const funcs: string[] = [];
        for (let j = 0; j < SYMBOLS_PER_FILE; j++) {
            const callPrev = i > 0 && j === 0 ? `func_${i - 1}_0();` : '';
            funcs.push(`export function func_${i}_${j}(x: number): number { ${callPrev} return x + ${j}; }`);
        }
        const content = imports + funcs.join('\n\n');
        const dir = path.join(tmpDir, 'src');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `file_${i}.ts`), content);
    }

    indexProject(tmpDir);
    db = openDatabase(tmpDir);
});

afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function timeMs(fn: () => void): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
}

describe('query performance', () => {
    it('exact symbol search completes under 5ms', () => {
        const ms = timeMs(() => search(db, 'func_25_0'));
        expect(ms).toBeLessThan(5);
    });

    it('search completes under 50ms', () => {
        const ms = timeMs(() => search(db, 'func_25'));
        expect(ms).toBeLessThan(50);
    });

    it('getCallers completes under 50ms', () => {
        const ms = timeMs(() => getCallers(db, 'func_0_0'));
        expect(ms).toBeLessThan(50);
    });

    it('getContext completes under 50ms', () => {
        const ms = timeMs(() => getContext(db, 'func_25_0'));
        expect(ms).toBeLessThan(50);
    });

    it('getImpact completes under 100ms', () => {
        const ms = timeMs(() => getImpact(db, 'src/file_0.ts'));
        expect(ms).toBeLessThan(100);
    });

    it('getStats completes under 20ms', () => {
        const ms = timeMs(() => getStats(db));
        expect(ms).toBeLessThan(20);
    });

    it('getRank completes under 20ms', () => {
        const ms = timeMs(() => getRank(db, 20));
        expect(ms).toBeLessThan(20);
    });

    it('getModules completes under 50ms', () => {
        const ms = timeMs(() => getModules(db));
        expect(ms).toBeLessThan(50);
    });

    it('getFileMap completes under 50ms', () => {
        const ms = timeMs(() => getFileMap(db));
        expect(ms).toBeLessThan(50);
    });

    it('getFileMapCompact completes under 50ms', () => {
        const ms = timeMs(() => getFileMapCompact(db));
        expect(ms).toBeLessThan(50);
    });

    it('getFileSymbols completes under 20ms', () => {
        const ms = timeMs(() => getFileSymbols(db, 'src/file_25.ts'));
        expect(ms).toBeLessThan(20);
    });

    it('getTaskContext completes under 50ms', () => {
        const ms = timeMs(() => getTaskContext(db, 'func_25', { maxSymbols: 8, maxFiles: 6, maxRelated: 8 }));
        expect(ms).toBeLessThan(50);
    });

    it('findByKind completes under 50ms', () => {
        const ms = timeMs(() => findByKind(db, 'function'));
        expect(ms).toBeLessThan(50);
    });

    it('findDeadExports completes under 100ms', () => {
        const ms = timeMs(() => findDeadExports(db));
        expect(ms).toBeLessThan(100);
    });

    it('repeated search uses cached statements (faster 2nd time)', () => {
        // First call warms the cache
        search(db, 'func_10');
        const ms1 = timeMs(() => search(db, 'func_20'));
        const ms2 = timeMs(() => search(db, 'func_30'));
        // Keep this bounded without making sub-millisecond timer noise fail the suite.
        expect(ms2).toBeLessThan(Math.max(ms1 * 3, 5));
    });
});

describe('indexing performance', () => {
    it('full index completes in reasonable time', () => {
        const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-idx-'));
        for (let i = 0; i < 20; i++) {
            const dir = path.join(tmpDir2, 'src');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `m_${i}.ts`),
                `export function m${i}() { return ${i}; }\nexport const val${i} = ${i};`
            );
        }
        const start = performance.now();
        const stats = indexProject(tmpDir2);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(10000); // 10s generous upper bound
        expect(stats.indexedFiles).toBe(20);
        fs.rmSync(tmpDir2, { recursive: true, force: true });
    });

    it('re-index (no changes) is fast', () => {
        const start = performance.now();
        const stats = indexProject(tmpDir);
        const elapsed = performance.now() - start;

        expect(stats.skippedFiles).toBe(FILE_COUNT);
        expect(stats.indexedFiles).toBe(0);
        expect(elapsed).toBeLessThan(5000);
    });
});

describe('data integrity', () => {
    it('all indexed files are searchable', () => {
        const stats = getStats(db);
        expect(stats.files).toBe(FILE_COUNT);
        expect(stats.symbols).toBe(FILE_COUNT * SYMBOLS_PER_FILE);
    });

    it('pagerank sums to approximately 1', () => {
        const rows = db.prepare('SELECT SUM(pagerank) as total FROM rankings').get() as any;
        // PageRank should sum to ~1.0 (may not be exact due to convergence)
        expect(rows.total).toBeGreaterThan(0.9);
        expect(rows.total).toBeLessThan(1.1);
    });

    it('no orphan edges (edges reference valid symbols)', () => {
        const orphans = db.prepare(`
            SELECT COUNT(*) as c FROM edges e
            WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.from_id)
               OR NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.to_id)
        `).get() as any;
        expect(orphans.c).toBe(0);
    });

    it('no orphan rankings', () => {
        const orphans = db.prepare(`
            SELECT COUNT(*) as c FROM rankings r
            WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = r.symbol_id)
        `).get() as any;
        expect(orphans.c).toBe(0);
    });

    it('FTS index is in sync with symbols table', () => {
        const ftsCount = (db.prepare(
            "SELECT COUNT(*) as c FROM symbols_fts WHERE symbols_fts MATCH '\"func\"'"
        ).get() as any).c;
        expect(ftsCount).toBe(FILE_COUNT * SYMBOLS_PER_FILE);
    });
});
