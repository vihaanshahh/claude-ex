import Database from 'better-sqlite3';
import { openDatabase } from '../db/schema';

// Result types
export interface SearchResult {
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    pagerank: number;
    snippet?: string;
}

export interface ContextResult {
    symbol: {
        name: string;
        qualifiedName: string | null;
        kind: string;
        file: string;
        lineStart: number;
        lineEnd: number;
        signature: string | null;
        docstring: string | null;
        code: string | null;
    };
    dependencies: SearchResult[];
    dependents: SearchResult[];
    sameFileSymbols: SearchResult[];
}

export interface ImpactResult {
    file: string;
    depth: number;
    symbolCount: number;
}

export interface ModuleResult {
    name: string;
    fileCount: number;
    symbolCount: number;
    importsFrom: string[];
}

export interface Stats {
    files: number;
    symbols: number;
    edges: number;
    fileDeps: number;
}

// FTS5 query sanitizer
function sanitizeFts(query: string): string {
    const tokens = query.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '';
    return tokens.map(t => `"${t}"`).join(' OR ');
}

// --- DB-direct functions (for MCP server hot path) ---

export function search(db: Database.Database, query: string, limit: number = 15): SearchResult[] {
    const ftsQuery = sanitizeFts(query);
    if (!ftsQuery) return [];

    const stmt = db.prepare(`
        SELECT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature,
               COALESCE(r.pagerank, 0) as pagerank,
               snippet(symbols_fts, 4, '>>>', '<<<', '...', 30) as snippet
        FROM symbols_fts fts
        JOIN symbols s ON s.id = fts.rowid
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE symbols_fts MATCH ?
        ORDER BY r.pagerank DESC, fts.rank
        LIMIT ?
    `);
    return stmt.all(ftsQuery, limit) as SearchResult[];
}

export function getCallers(db: Database.Database, symbolName: string): SearchResult[] {
    const stmt = db.prepare(`
        SELECT DISTINCT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature,
               COALESCE(r.pagerank, 0) as pagerank
        FROM edges e
        JOIN symbols target ON target.id = e.to_id
        JOIN symbols s ON s.id = e.from_id
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE (target.name = ? OR target.qualified_name = ?)
          AND e.kind IN ('calls', 'references')
        ORDER BY r.pagerank DESC
    `);
    return stmt.all(symbolName, symbolName) as SearchResult[];
}

export function getContext(db: Database.Database, symbolName: string): ContextResult | null {
    // Find the symbol (prefer exported, highest pagerank)
    const sym = db.prepare(`
        SELECT s.id, s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature, s.docstring, s.content as code,
               s.file_id
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE s.name = ? OR s.qualified_name = ?
        ORDER BY s.exported DESC, COALESCE(r.pagerank, 0) DESC
        LIMIT 1
    `).get(symbolName, symbolName) as any;

    if (!sym) return null;

    // Dependencies (edges FROM this symbol)
    const deps = db.prepare(`
        SELECT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature,
               COALESCE(r.pagerank, 0) as pagerank
        FROM edges e
        JOIN symbols s ON s.id = e.to_id
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE e.from_id = ?
    `).all(sym.id) as SearchResult[];

    // Dependents (edges TO this symbol)
    const dependents = db.prepare(`
        SELECT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature,
               COALESCE(r.pagerank, 0) as pagerank
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE e.to_id = ?
    `).all(sym.id) as SearchResult[];

    // Same-file siblings
    const siblings = db.prepare(`
        SELECT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature,
               COALESCE(r.pagerank, 0) as pagerank
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE s.file_id = ? AND s.id != ?
        ORDER BY s.line_start
    `).all(sym.file_id, sym.id) as SearchResult[];

    return {
        symbol: {
            name: sym.name,
            qualifiedName: sym.qualified_name,
            kind: sym.kind,
            file: sym.file,
            lineStart: sym.line_start,
            lineEnd: sym.line_end,
            signature: sym.signature,
            docstring: sym.docstring,
            code: sym.code,
        },
        dependencies: deps,
        dependents,
        sameFileSymbols: siblings,
    };
}

export function getImpact(db: Database.Database, filePath: string, maxDepth: number = 10): ImpactResult[] {
    const stmt = db.prepare(`
        WITH RECURSIVE impact(file_id, depth) AS (
            SELECT fd.from_file, 1
            FROM file_deps fd
            JOIN files f ON f.id = fd.to_file
            WHERE f.path = ?
            UNION
            SELECT fd.from_file, i.depth + 1
            FROM file_deps fd
            JOIN impact i ON i.file_id = fd.to_file
            WHERE i.depth < ?
        )
        SELECT f.path as file, MIN(i.depth) as depth,
               (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id) as symbolCount
        FROM impact i
        JOIN files f ON f.id = i.file_id
        GROUP BY f.path
        ORDER BY depth, symbolCount DESC
    `);
    return stmt.all(filePath, maxDepth) as ImpactResult[];
}

export function getDeps(db: Database.Database, symbolName: string): SearchResult[] {
    const stmt = db.prepare(`
        SELECT DISTINCT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature,
               COALESCE(r.pagerank, 0) as pagerank
        FROM edges e
        JOIN symbols source ON source.id = e.from_id
        JOIN symbols s ON s.id = e.to_id
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE (source.name = ? OR source.qualified_name = ?)
        ORDER BY r.pagerank DESC
    `);
    return stmt.all(symbolName, symbolName) as SearchResult[];
}

export function getRank(db: Database.Database, top: number = 20): SearchResult[] {
    const stmt = db.prepare(`
        SELECT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature,
               r.pagerank
        FROM rankings r
        JOIN symbols s ON s.id = r.symbol_id
        JOIN files f ON f.id = s.file_id
        WHERE s.kind IN ('function', 'class', 'method', 'interface', 'type')
        ORDER BY r.pagerank DESC
        LIMIT ?
    `);
    return stmt.all(top) as SearchResult[];
}

export function getModules(db: Database.Database): ModuleResult[] {
    // Group files by top-level directory
    const files = db.prepare(`
        SELECT f.id, f.path,
               CASE WHEN INSTR(f.path, '/') > 0
                    THEN SUBSTR(f.path, 1, INSTR(f.path, '/') - 1)
                    ELSE '.'
               END as module
        FROM files f
    `).all() as { id: number; path: string; module: string }[];

    const moduleMap = new Map<string, { fileIds: Set<number>; files: string[] }>();
    for (const f of files) {
        if (!moduleMap.has(f.module)) {
            moduleMap.set(f.module, { fileIds: new Set(), files: [] });
        }
        moduleMap.get(f.module)!.fileIds.add(f.id);
        moduleMap.get(f.module)!.files.push(f.path);
    }

    const results: ModuleResult[] = [];
    for (const [name, data] of moduleMap) {
        const symbolCount = db.prepare(
            `SELECT COUNT(*) as cnt FROM symbols WHERE file_id IN (${[...data.fileIds].join(',')})`
        ).get() as { cnt: number };

        // Find which other modules this module imports from
        const deps = db.prepare(`
            SELECT DISTINCT
                CASE WHEN INSTR(f2.path, '/') > 0
                     THEN SUBSTR(f2.path, 1, INSTR(f2.path, '/') - 1)
                     ELSE '.'
                END as target_module
            FROM file_deps fd
            JOIN files f2 ON f2.id = fd.to_file
            WHERE fd.from_file IN (${[...data.fileIds].join(',')})
        `).all() as { target_module: string }[];

        results.push({
            name,
            fileCount: data.files.length,
            symbolCount: symbolCount.cnt,
            importsFrom: deps.map(d => d.target_module).filter(m => m !== name),
        });
    }

    return results.sort((a, b) => b.symbolCount - a.symbolCount);
}

export function getStats(db: Database.Database): Stats {
    const files = (db.prepare('SELECT COUNT(*) as cnt FROM files').get() as any).cnt;
    const symbols = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as any).cnt;
    const edges = (db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any).cnt;
    const fileDeps = (db.prepare('SELECT COUNT(*) as cnt FROM file_deps').get() as any).cnt;
    return { files, symbols, edges, fileDeps };
}

export function brief(db: Database.Database): string {
    const stats = getStats(db);
    const topSymbols = getRank(db, 10);
    const modules = getModules(db);

    // Language breakdown
    const langs = db.prepare(`
        SELECT language, COUNT(*) as cnt FROM files WHERE language IS NOT NULL GROUP BY language ORDER BY cnt DESC
    `).all() as { language: string; cnt: number }[];

    const lines: string[] = [];
    lines.push(`Project: ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} relationships`);

    if (langs.length > 0) {
        lines.push(`Languages: ${langs.map(l => `${l.language} (${l.cnt})`).join(', ')}`);
    }

    if (modules.length > 0) {
        lines.push(`Modules: ${modules.slice(0, 8).map(m => `${m.name}/ (${m.fileCount} files)`).join(', ')}`);
    }

    if (topSymbols.length > 0) {
        lines.push('');
        lines.push('Key symbols (by structural importance):');
        for (const sym of topSymbols) {
            lines.push(`  ${sym.qualifiedName || sym.name} [${sym.kind}] in ${sym.file}`);
        }
    }

    lines.push('');
    lines.push('Use MCP tools (search_code, get_callers, get_dependents, get_symbol) for structural queries.');
    return lines.join('\n');
}

export function preEditContext(db: Database.Database, filePath: string): string {
    const file = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
    if (!file) return `File ${filePath} not in index.`;

    const lines: string[] = [];

    // What this file exports
    const exports = db.prepare(`
        SELECT name, kind, signature FROM symbols WHERE file_id = ? AND exported = 1 ORDER BY line_start
    `).all(file.id) as { name: string; kind: string; signature: string | null }[];

    if (exports.length > 0) {
        lines.push(`Exports from ${filePath}:`);
        for (const exp of exports) {
            lines.push(`  ${exp.name} [${exp.kind}]${exp.signature ? ': ' + exp.signature.slice(0, 80) : ''}`);
        }
    }

    // What files import from this file
    const dependents = db.prepare(`
        SELECT DISTINCT f.path FROM file_deps fd JOIN files f ON f.id = fd.from_file WHERE fd.to_file = ?
    `).all(file.id) as { path: string }[];

    if (dependents.length > 0) {
        lines.push('');
        lines.push(`\u26a0\ufe0f ${dependents.length} file(s) depend on this file:`);
        for (const dep of dependents.slice(0, 15)) {
            lines.push(`  ${dep.path}`);
        }
        if (dependents.length > 15) {
            lines.push(`  ... and ${dependents.length - 15} more`);
        }
    }

    // What this file imports
    const imports = db.prepare(`
        SELECT f.path, fd.import_name FROM file_deps fd JOIN files f ON f.id = fd.to_file WHERE fd.from_file = ?
    `).all(file.id) as { path: string; import_name: string }[];

    if (imports.length > 0) {
        lines.push('');
        lines.push('Imports:');
        for (const imp of imports) {
            lines.push(`  from ${imp.path} (${imp.import_name})`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : `File ${filePath} indexed but has no tracked exports/imports.`;
}

// --- Convenience wrappers for CLI (open/close DB internally) ---

function withDb<T>(rootDir: string, fn: (db: Database.Database) => T): T {
    const db = openDatabase(rootDir);
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

export function searchFromRoot(rootDir: string, query: string, limit?: number): SearchResult[] {
    return withDb(rootDir, db => search(db, query, limit));
}

export function getCallersFromRoot(rootDir: string, name: string): SearchResult[] {
    return withDb(rootDir, db => getCallers(db, name));
}

export function getContextFromRoot(rootDir: string, name: string): ContextResult | null {
    return withDb(rootDir, db => getContext(db, name));
}

export function getImpactFromRoot(rootDir: string, file: string, maxDepth?: number): ImpactResult[] {
    return withDb(rootDir, db => getImpact(db, file, maxDepth));
}

export function getDepsFromRoot(rootDir: string, name: string): SearchResult[] {
    return withDb(rootDir, db => getDeps(db, name));
}

export function getRankFromRoot(rootDir: string, top?: number): SearchResult[] {
    return withDb(rootDir, db => getRank(db, top));
}

export function getModulesFromRoot(rootDir: string): ModuleResult[] {
    return withDb(rootDir, db => getModules(db));
}

export function getStatsFromRoot(rootDir: string): Stats {
    return withDb(rootDir, db => getStats(db));
}

export function briefFromRoot(rootDir: string): string {
    return withDb(rootDir, db => brief(db));
}

export function preEditContextFromRoot(rootDir: string, filePath: string): string {
    return withDb(rootDir, db => preEditContext(db, filePath));
}
