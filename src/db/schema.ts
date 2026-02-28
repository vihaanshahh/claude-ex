import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { ensureCodexDir } from '../utils';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    language TEXT,
    content_hash TEXT NOT NULL,
    line_count INTEGER DEFAULT 0,
    last_modified INTEGER,
    last_indexed INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    qualified_name TEXT,
    kind TEXT NOT NULL,
    file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
    line_start INTEGER,
    line_end INTEGER,
    signature TEXT,
    docstring TEXT,
    content TEXT,
    content_hash TEXT,
    exported INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS edges (
    from_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
    to_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE IF NOT EXISTS file_deps (
    from_file INTEGER REFERENCES files(id) ON DELETE CASCADE,
    to_file INTEGER REFERENCES files(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    import_name TEXT,
    PRIMARY KEY (from_file, to_file, kind, import_name)
);

CREATE TABLE IF NOT EXISTS rankings (
    symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
    pagerank REAL DEFAULT 0,
    in_degree INTEGER DEFAULT 0,
    out_degree INTEGER DEFAULT 0
);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name, qualified_name, signature, docstring, content,
    content='symbols', content_rowid='id',
    tokenize='porter unicode61'
);
`;

const TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(rowid, name, qualified_name, signature, docstring, content)
    VALUES (new.id, new.name, new.qualified_name, new.signature, new.docstring, new.content);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, signature, docstring, content)
    VALUES('delete', old.id, old.name, old.qualified_name, old.signature, old.docstring, old.content);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, signature, docstring, content)
    VALUES('delete', old.id, old.name, old.qualified_name, old.signature, old.docstring, old.content);
    INSERT INTO symbols_fts(rowid, name, qualified_name, signature, docstring, content)
    VALUES (new.id, new.name, new.qualified_name, new.signature, new.docstring, new.content);
END;
`;

const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id, kind);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
CREATE INDEX IF NOT EXISTS idx_file_deps_to ON file_deps(to_file);
CREATE INDEX IF NOT EXISTS idx_file_deps_from ON file_deps(from_file);
`;

const PRAGMAS = [
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = NORMAL',
    'PRAGMA cache_size = -64000',
    'PRAGMA foreign_keys = ON',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA mmap_size = 268435456',
];

export function openDatabase(projectRoot: string): Database.Database {
    const codexDir = ensureCodexDir(projectRoot);
    const dbPath = path.join(codexDir, 'index.db');
    const db = new Database(dbPath);

    for (const pragma of PRAGMAS) {
        db.pragma(pragma.replace('PRAGMA ', ''));
    }

    db.exec(SCHEMA_SQL);
    db.exec(FTS_SQL);
    db.exec(TRIGGERS_SQL);
    db.exec(INDEXES_SQL);

    return db;
}

export interface FileRecord {
    id: number;
    changed: boolean;
}

const getFileStmt = new WeakMap<Database.Database, Database.Statement>();
const insertFileStmt = new WeakMap<Database.Database, Database.Statement>();
const updateFileStmt = new WeakMap<Database.Database, Database.Statement>();

function getOrPrepare<T extends Database.Statement>(
    map: WeakMap<Database.Database, T>,
    db: Database.Database,
    sql: string
): Database.Statement {
    let stmt = map.get(db);
    if (!stmt) {
        stmt = db.prepare(sql) as T;
        map.set(db, stmt);
    }
    return stmt;
}

export function getOrCreateFile(
    db: Database.Database,
    filePath: string,
    hash: string,
    language: string | null,
    lineCount: number
): FileRecord {
    const get = getOrPrepare(
        getFileStmt, db,
        'SELECT id, content_hash FROM files WHERE path = ?'
    );
    const existing = get.get(filePath) as { id: number; content_hash: string } | undefined;

    if (existing) {
        if (existing.content_hash === hash) {
            return { id: existing.id, changed: false };
        }
        const update = getOrPrepare(
            updateFileStmt, db,
            'UPDATE files SET content_hash = ?, language = ?, line_count = ?, last_indexed = ? WHERE id = ?'
        );
        update.run(hash, language, lineCount, Date.now(), existing.id);
        return { id: existing.id, changed: true };
    }

    const insert = getOrPrepare(
        insertFileStmt, db,
        'INSERT INTO files (path, content_hash, language, line_count, last_indexed) VALUES (?, ?, ?, ?, ?)'
    );
    const result = insert.run(filePath, hash, language, lineCount, Date.now());
    return { id: Number(result.lastInsertRowid), changed: true };
}

export function clearFileData(db: Database.Database, fileId: number): void {
    db.prepare('DELETE FROM rankings WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileId);
    db.prepare('DELETE FROM edges WHERE from_id IN (SELECT id FROM symbols WHERE file_id = ?) OR to_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileId, fileId);
    db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM file_deps WHERE from_file = ?').run(fileId);
}

export interface SymbolData {
    name: string;
    qualifiedName?: string;
    kind: string;
    lineStart: number;
    lineEnd: number;
    signature?: string;
    docstring?: string;
    content?: string;
    contentHash?: string;
    exported?: boolean;
}

export function insertSymbol(db: Database.Database, fileId: number, sym: SymbolData): number {
    const stmt = db.prepare(
        `INSERT INTO symbols (name, qualified_name, kind, file_id, line_start, line_end, signature, docstring, content, content_hash, exported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
        sym.name,
        sym.qualifiedName || null,
        sym.kind,
        fileId,
        sym.lineStart,
        sym.lineEnd,
        sym.signature || null,
        sym.docstring || null,
        sym.content || null,
        sym.contentHash || null,
        sym.exported ? 1 : 0
    );
    return Number(result.lastInsertRowid);
}

export function insertEdge(db: Database.Database, fromId: number, toId: number, kind: string): void {
    db.prepare('INSERT OR IGNORE INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)').run(fromId, toId, kind);
}

export function insertFileDep(
    db: Database.Database,
    fromFile: number,
    toFile: number,
    kind: string,
    importName: string
): void {
    db.prepare(
        'INSERT OR IGNORE INTO file_deps (from_file, to_file, kind, import_name) VALUES (?, ?, ?, ?)'
    ).run(fromFile, toFile, kind, importName);
}

export function removeStaleFiles(db: Database.Database, validPaths: Set<string>): number {
    const allFiles = db.prepare('SELECT id, path FROM files').all() as { id: number; path: string }[];
    let removed = 0;
    for (const file of allFiles) {
        if (!validPaths.has(file.path)) {
            clearFileData(db, file.id);
            db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
            removed++;
        }
    }
    return removed;
}

export function removeFile(db: Database.Database, filePath: string): void {
    const file = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
    if (file) {
        clearFileData(db, file.id);
        db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    }
}
