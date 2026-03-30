import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { ensureCodexDir, getCodexDir } from '../utils';

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
    line INTEGER,
    PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE IF NOT EXISTS file_deps (
    from_file INTEGER REFERENCES files(id) ON DELETE CASCADE,
    to_file INTEGER REFERENCES files(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    import_name TEXT,
    PRIMARY KEY (from_file, to_file, kind, import_name)
);

CREATE TABLE IF NOT EXISTS pkg_deps (
    file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
    package TEXT NOT NULL,
    imported_names TEXT,
    PRIMARY KEY (file_id, package)
);

CREATE TABLE IF NOT EXISTS type_relations (
    child_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
    parent_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (child_id, parent_name, kind)
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
    tokenize='porter unicode61',
    prefix='2 4'
);
`;

const TRIGRAM_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_trigram USING fts5(
    name, qualified_name, signature,
    content='symbols', content_rowid='id',
    tokenize='trigram',
    detail='none'
);
`;

const TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(rowid, name, qualified_name, signature, docstring, content)
    VALUES (new.id, new.name, new.qualified_name, new.signature, new.docstring, new.content);
    INSERT INTO symbols_trigram(rowid, name, qualified_name, signature)
    VALUES (new.id, new.name, new.qualified_name, new.signature);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, signature, docstring, content)
    VALUES('delete', old.id, old.name, old.qualified_name, old.signature, old.docstring, old.content);
    INSERT INTO symbols_trigram(symbols_trigram, rowid, name, qualified_name, signature)
    VALUES('delete', old.id, old.name, old.qualified_name, old.signature);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, signature, docstring, content)
    VALUES('delete', old.id, old.name, old.qualified_name, old.signature, old.docstring, old.content);
    INSERT INTO symbols_fts(rowid, name, qualified_name, signature, docstring, content)
    VALUES (new.id, new.name, new.qualified_name, new.signature, new.docstring, new.content);
    INSERT INTO symbols_trigram(symbols_trigram, rowid, name, qualified_name, signature)
    VALUES('delete', old.id, old.name, old.qualified_name, old.signature);
    INSERT INTO symbols_trigram(rowid, name, qualified_name, signature)
    VALUES (new.id, new.name, new.qualified_name, new.signature);
END;
`;

const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(exported, file_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id, kind);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
CREATE INDEX IF NOT EXISTS idx_file_deps_to ON file_deps(to_file);
CREATE INDEX IF NOT EXISTS idx_file_deps_from ON file_deps(from_file);
CREATE INDEX IF NOT EXISTS idx_pkg_deps_package ON pkg_deps(package);
CREATE INDEX IF NOT EXISTS idx_pkg_deps_file ON pkg_deps(file_id);
CREATE INDEX IF NOT EXISTS idx_type_relations_parent ON type_relations(parent_name);
CREATE INDEX IF NOT EXISTS idx_type_relations_child ON type_relations(child_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_symbols_file_line ON symbols(file_id, line_start);
CREATE INDEX IF NOT EXISTS idx_file_deps_to_from ON file_deps(to_file, from_file);
CREATE INDEX IF NOT EXISTS idx_symbols_exported_kind ON symbols(exported, kind);
CREATE INDEX IF NOT EXISTS idx_rankings_pagerank ON rankings(pagerank DESC);
`;

const PRAGMAS = [
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = NORMAL',
    'PRAGMA cache_size = -64000',
    'PRAGMA foreign_keys = ON',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA mmap_size = 268435456',
];

export function openDatabase(projectRoot: string, work?: boolean): Database.Database {
    const codexDir = work !== undefined ? ensureCodexDir(projectRoot, work) : ensureCodexDir(projectRoot);
    const dbPath = path.join(codexDir, 'index.db');

    function initDb(): Database.Database {
        const db = new Database(dbPath);

        for (const pragma of PRAGMAS) {
            db.pragma(pragma.replace('PRAGMA ', ''));
        }

        db.exec(SCHEMA_SQL);
        db.exec(FTS_SQL);
        db.exec(INDEXES_SQL);

        // Trigram table — may fail on older SQLite without trigram tokenizer
        try { db.exec(TRIGRAM_SQL); } catch { /* trigram tokenizer not available */ }

        // Recreate triggers to include trigram sync (DROP + CREATE is safe)
        db.exec(`
            DROP TRIGGER IF EXISTS symbols_ai;
            DROP TRIGGER IF EXISTS symbols_ad;
            DROP TRIGGER IF EXISTS symbols_au;
        `);
        db.exec(TRIGGERS_SQL);

        // Migrations for existing databases
        migrateSchema(db);

        return db;
    }

    try {
        return initDb();
    } catch (err: unknown) {
        const code = (err as { code?: string }).code ?? '';
        if (code.startsWith('SQLITE_CORRUPT')) {
            // Database is corrupted — delete and recreate from scratch
            try { fs.unlinkSync(dbPath); } catch { /* already gone */ }
            // Also remove WAL/SHM sidecar files
            try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ok */ }
            try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ok */ }
            process.stderr.write(`Warning: corrupted index database deleted, rebuilding...\n`);
            return initDb();
        }
        throw err;
    }
}

function migrateSchema(db: Database.Database): void {
    // Add columns that may not exist in older databases
    const migrations = [
        'ALTER TABLE symbols ADD COLUMN parameters TEXT',
        'ALTER TABLE edges ADD COLUMN line INTEGER',
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch { /* column already exists */ }
    }
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
    lineCount: number,
    lastModified?: number
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
            'UPDATE files SET content_hash = ?, language = ?, line_count = ?, last_modified = ?, last_indexed = ? WHERE id = ?'
        );
        update.run(hash, language, lineCount, lastModified || Date.now(), Date.now(), existing.id);
        return { id: existing.id, changed: true };
    }

    const insert = getOrPrepare(
        insertFileStmt, db,
        'INSERT INTO files (path, content_hash, language, line_count, last_modified, last_indexed) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const result = insert.run(filePath, hash, language, lineCount, lastModified || Date.now(), Date.now());
    return { id: Number(result.lastInsertRowid), changed: true };
}

const clearStmts = new WeakMap<Database.Database, Database.Statement[]>();

export function clearFileData(db: Database.Database, fileId: number): void {
    let stmts = clearStmts.get(db);
    if (!stmts) {
        stmts = [
            db.prepare('DELETE FROM rankings WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)'),
            db.prepare('DELETE FROM type_relations WHERE child_id IN (SELECT id FROM symbols WHERE file_id = ?)'),
            db.prepare('DELETE FROM edges WHERE from_id IN (SELECT id FROM symbols WHERE file_id = ?) OR to_id IN (SELECT id FROM symbols WHERE file_id = ?)'),
            db.prepare('DELETE FROM symbols WHERE file_id = ?'),
            db.prepare('DELETE FROM file_deps WHERE from_file = ?'),
            db.prepare('DELETE FROM pkg_deps WHERE file_id = ?'),
        ];
        clearStmts.set(db, stmts);
    }
    stmts[0].run(fileId);
    stmts[1].run(fileId);
    stmts[2].run(fileId, fileId);
    stmts[3].run(fileId);
    stmts[4].run(fileId);
    stmts[5].run(fileId);
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
    parameters?: string;  // JSON array of {name, type} pairs
}

const insertSymbolStmt = new WeakMap<Database.Database, Database.Statement>();

export function insertSymbol(db: Database.Database, fileId: number, sym: SymbolData): number {
    const stmt = getOrPrepare(insertSymbolStmt, db,
        `INSERT INTO symbols (name, qualified_name, kind, file_id, line_start, line_end, signature, docstring, content, content_hash, exported, parameters)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        sym.exported ? 1 : 0,
        sym.parameters || null
    );
    return Number(result.lastInsertRowid);
}

const insertEdgeStmt = new WeakMap<Database.Database, Database.Statement>();

export function insertEdge(db: Database.Database, fromId: number, toId: number, kind: string, line?: number): void {
    getOrPrepare(insertEdgeStmt, db, 'INSERT OR IGNORE INTO edges (from_id, to_id, kind, line) VALUES (?, ?, ?, ?)').run(fromId, toId, kind, line || null);
}

const insertPkgDepStmt = new WeakMap<Database.Database, Database.Statement>();

export function insertPkgDep(db: Database.Database, fileId: number, packageName: string, importedNames: string): void {
    getOrPrepare(insertPkgDepStmt, db, 'INSERT OR IGNORE INTO pkg_deps (file_id, package, imported_names) VALUES (?, ?, ?)').run(fileId, packageName, importedNames);
}

const insertTypeRelationStmt = new WeakMap<Database.Database, Database.Statement>();

export function insertTypeRelation(db: Database.Database, childId: number, parentName: string, kind: string): void {
    getOrPrepare(insertTypeRelationStmt, db, 'INSERT OR IGNORE INTO type_relations (child_id, parent_name, kind) VALUES (?, ?, ?)').run(childId, parentName, kind);
}

const insertFileDepStmt = new WeakMap<Database.Database, Database.Statement>();

export function insertFileDep(
    db: Database.Database,
    fromFile: number,
    toFile: number,
    kind: string,
    importName: string
): void {
    getOrPrepare(insertFileDepStmt, db, 'INSERT OR IGNORE INTO file_deps (from_file, to_file, kind, import_name) VALUES (?, ?, ?, ?)').run(fromFile, toFile, kind, importName);
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
