import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    openDatabase, getOrCreateFile, clearFileData,
    insertSymbol, insertEdge, insertPkgDep, insertTypeRelation, insertFileDep,
} from '../src/db/schema';

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
    db = openDatabase(tmpDir);
});

afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('openDatabase', () => {
    it('creates .codex directory and index.db', () => {
        expect(fs.existsSync(path.join(tmpDir, '.codex', 'index.db'))).toBe(true);
    });

    it('sets WAL journal mode', () => {
        const mode = db.pragma('journal_mode', { simple: true });
        expect(mode).toBe('wal');
    });

    it('creates all required tables', () => {
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).all() as { name: string }[];
        const names = tables.map(t => t.name);
        expect(names).toContain('files');
        expect(names).toContain('symbols');
        expect(names).toContain('edges');
        expect(names).toContain('file_deps');
        expect(names).toContain('pkg_deps');
        expect(names).toContain('type_relations');
        expect(names).toContain('rankings');
    });

    it('creates FTS5 tables', () => {
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%' OR name LIKE '%trigram%' ORDER BY name"
        ).all() as { name: string }[];
        const names = tables.map(t => t.name);
        expect(names.some(n => n.includes('symbols_fts'))).toBe(true);
    });

    it('creates all required indexes', () => {
        const indexes = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
        ).all() as { name: string }[];
        const names = indexes.map(i => i.name);
        expect(names).toContain('idx_files_path');
        expect(names).toContain('idx_symbols_file');
        expect(names).toContain('idx_symbols_name');
        expect(names).toContain('idx_symbols_name_nocase');
        expect(names).toContain('idx_symbols_qualified_nocase');
        expect(names).toContain('idx_symbols_file_line');
        expect(names).toContain('idx_edges_to');
        expect(names).toContain('idx_edges_from');
        expect(names).toContain('idx_rankings_pagerank');
    });

    it('is idempotent — opening twice does not error', () => {
        const db2 = openDatabase(tmpDir);
        expect(db2).toBeDefined();
        db2.close();
    });
});

describe('getOrCreateFile', () => {
    it('inserts a new file', () => {
        const rec = getOrCreateFile(db, 'src/index.ts', 'hash1', 'typescript', 50);
        expect(rec.id).toBeGreaterThan(0);
        expect(rec.changed).toBe(true);
    });

    it('returns unchanged for same hash', () => {
        getOrCreateFile(db, 'src/index.ts', 'hash1', 'typescript', 50);
        const rec2 = getOrCreateFile(db, 'src/index.ts', 'hash1', 'typescript', 50);
        expect(rec2.changed).toBe(false);
    });

    it('detects changes when hash differs', () => {
        getOrCreateFile(db, 'src/index.ts', 'hash1', 'typescript', 50);
        const rec2 = getOrCreateFile(db, 'src/index.ts', 'hash2', 'typescript', 55);
        expect(rec2.changed).toBe(true);
    });
});

describe('insertSymbol', () => {
    it('inserts and returns an id', () => {
        const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10);
        const id = insertSymbol(db, file.id, {
            name: 'myFunc', kind: 'function', lineStart: 1, lineEnd: 5,
            signature: 'function myFunc(): void', exported: true,
        });
        expect(id).toBeGreaterThan(0);
    });

    it('is searchable via FTS after insert', () => {
        const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10);
        insertSymbol(db, file.id, {
            name: 'calculateTotal', kind: 'function', lineStart: 1, lineEnd: 5,
            exported: true,
        });
        const results = db.prepare(
            "SELECT * FROM symbols_fts WHERE symbols_fts MATCH '\"calculateTotal\"'"
        ).all();
        expect(results.length).toBeGreaterThan(0);
    });
});

describe('insertEdge', () => {
    it('creates an edge between symbols', () => {
        const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10);
        const id1 = insertSymbol(db, file.id, { name: 'a', kind: 'function', lineStart: 1, lineEnd: 2 });
        const id2 = insertSymbol(db, file.id, { name: 'b', kind: 'function', lineStart: 3, lineEnd: 4 });
        insertEdge(db, id1, id2, 'calls');
        const edges = db.prepare('SELECT * FROM edges WHERE from_id = ? AND to_id = ?').all(id1, id2);
        expect(edges.length).toBe(1);
    });

    it('is idempotent (INSERT OR IGNORE)', () => {
        const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10);
        const id1 = insertSymbol(db, file.id, { name: 'a', kind: 'function', lineStart: 1, lineEnd: 2 });
        const id2 = insertSymbol(db, file.id, { name: 'b', kind: 'function', lineStart: 3, lineEnd: 4 });
        insertEdge(db, id1, id2, 'calls');
        insertEdge(db, id1, id2, 'calls'); // duplicate
        const edges = db.prepare('SELECT * FROM edges WHERE from_id = ? AND to_id = ?').all(id1, id2);
        expect(edges.length).toBe(1);
    });
});

describe('clearFileData', () => {
    it('removes all symbols, edges, rankings for a file', () => {
        const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10);
        const id1 = insertSymbol(db, file.id, { name: 'a', kind: 'function', lineStart: 1, lineEnd: 2, exported: true });
        const id2 = insertSymbol(db, file.id, { name: 'b', kind: 'function', lineStart: 3, lineEnd: 4 });
        insertEdge(db, id1, id2, 'calls');
        insertPkgDep(db, file.id, 'lodash', 'get');
        insertTypeRelation(db, id1, 'Base', 'extends');

        clearFileData(db, file.id);

        expect((db.prepare('SELECT COUNT(*) as c FROM symbols WHERE file_id = ?').get(file.id) as any).c).toBe(0);
        expect((db.prepare('SELECT COUNT(*) as c FROM edges WHERE from_id = ? OR to_id = ?').get(id1, id1) as any).c).toBe(0);
        expect((db.prepare('SELECT COUNT(*) as c FROM pkg_deps WHERE file_id = ?').get(file.id) as any).c).toBe(0);
    });

    it('does not affect other files', () => {
        const file1 = getOrCreateFile(db, 'a.ts', 'h1', 'typescript', 10);
        const file2 = getOrCreateFile(db, 'b.ts', 'h2', 'typescript', 10);
        insertSymbol(db, file1.id, { name: 'a', kind: 'function', lineStart: 1, lineEnd: 2 });
        insertSymbol(db, file2.id, { name: 'b', kind: 'function', lineStart: 1, lineEnd: 2 });

        clearFileData(db, file1.id);

        expect((db.prepare('SELECT COUNT(*) as c FROM symbols WHERE file_id = ?').get(file2.id) as any).c).toBe(1);
    });
});

describe('insertFileDep + insertPkgDep', () => {
    it('tracks file dependencies', () => {
        const f1 = getOrCreateFile(db, 'a.ts', 'h1', 'typescript', 10);
        const f2 = getOrCreateFile(db, 'b.ts', 'h2', 'typescript', 10);
        insertFileDep(db, f1.id, f2.id, 'import', 'foo');
        const deps = db.prepare('SELECT * FROM file_deps WHERE from_file = ?').all(f1.id);
        expect(deps.length).toBe(1);
    });

    it('tracks package dependencies', () => {
        const f = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10);
        insertPkgDep(db, f.id, 'express', 'Router,Request');
        const deps = db.prepare('SELECT * FROM pkg_deps WHERE file_id = ?').all(f.id) as any[];
        expect(deps.length).toBe(1);
        expect(deps[0].package).toBe('express');
    });
});
