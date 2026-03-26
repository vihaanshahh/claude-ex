import Database from 'better-sqlite3';
import { execSync } from 'child_process';
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

export interface FileResult {
    path: string;
    language: string | null;
    lineCount: number;
}

export function findFiles(db: Database.Database, pattern: string, limit: number = 50): FileResult[] {
    // Convert glob-like pattern to SQL GLOB pattern
    // SQL GLOB uses * for any chars and ? for single char (same as shell glob)
    // But we want ** to match path separators too, which GLOB * already does
    const sqlPattern = pattern
        .replace(/\*\*/g, '*')  // ** -> * (SQL GLOB * matches everything including /)
        .replace(/\.\*/g, '.*'); // preserve .* as literal

    const stmt = db.prepare(`
        SELECT path, language, line_count as lineCount
        FROM files
        WHERE path GLOB ?
        ORDER BY path
        LIMIT ?
    `);
    return stmt.all(sqlPattern, limit) as FileResult[];
}

export interface FileMapEntry {
    path: string;
    language: string | null;
    lineCount: number;
    exports: string[];  // exported symbol names with kinds
}

/** Directories to exclude from file map (dependencies, build output) */
const FILE_MAP_SKIP = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', 'target', 'coverage']);

function isProjectFile(filePath: string): boolean {
    const firstDir = filePath.split('/')[0];
    return !FILE_MAP_SKIP.has(firstDir);
}

/** Returns a map of every project file → what it exports. This is the "memory" of the project. */
export function getFileMap(db: Database.Database): FileMapEntry[] {
    const files = db.prepare(`
        SELECT f.id, f.path, f.language, f.line_count as lineCount
        FROM files f
        ORDER BY f.path
    `).all() as { id: number; path: string; language: string | null; lineCount: number }[];

    const exportStmt = db.prepare(`
        SELECT name, kind, signature FROM symbols
        WHERE file_id = ? AND exported = 1
        ORDER BY line_start
    `);

    const results: FileMapEntry[] = [];
    for (const f of files) {
        if (!isProjectFile(f.path)) continue;
        const exports = exportStmt.all(f.id) as { name: string; kind: string; signature: string | null }[];
        results.push({
            path: f.path,
            language: f.language,
            lineCount: f.lineCount,
            exports: exports.map(e => `${e.name} [${e.kind}]`),
        });
    }
    return results;
}

/** Compact file map string for embedding in CLAUDE.md / brief */
export function getFileMapCompact(db: Database.Database, maxFiles: number = 80): string {
    const files = db.prepare(`
        SELECT f.id, f.path, f.language, f.line_count as lineCount
        FROM files f
        ORDER BY f.path
    `).all() as { id: number; path: string; language: string | null; lineCount: number }[];

    const projectFiles = files.filter(f => isProjectFile(f.path));

    const exportStmt = db.prepare(`
        SELECT name, kind FROM symbols
        WHERE file_id = ? AND exported = 1
        ORDER BY COALESCE((SELECT pagerank FROM rankings WHERE symbol_id = symbols.id), 0) DESC
        LIMIT 8
    `);

    const allExportStmt = db.prepare(`
        SELECT COUNT(*) as cnt FROM symbols WHERE file_id = ? AND exported = 1
    `);

    const lines: string[] = [];
    const shown = projectFiles.slice(0, maxFiles);

    for (const f of shown) {
        const exports = exportStmt.all(f.id) as { name: string; kind: string }[];
        const totalExports = (allExportStmt.get(f.id) as { cnt: number }).cnt;

        if (exports.length === 0) {
            lines.push(`- \`${f.path}\``);
        } else {
            const names = exports.map(e => e.name);
            const suffix = totalExports > names.length ? ` +${totalExports - names.length} more` : '';
            lines.push(`- \`${f.path}\` — ${names.join(', ')}${suffix}`);
        }
    }

    if (projectFiles.length > maxFiles) {
        lines.push(`- ... and ${projectFiles.length - maxFiles} more files`);
    }

    return lines.join('\n');
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

    // Compact file map — so Claude knows where everything is
    const fileMap = getFileMapCompact(db, 40);
    if (fileMap) {
        lines.push('');
        lines.push('File map (file → exports):');
        lines.push(fileMap);
    }

    lines.push('');
    lines.push('Use MCP tools (search_code, find_files, get_file_map, get_callers, get_dependents, get_symbol) for structural queries.');
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

// --- New query functions ---

export interface FileSymbolResult {
    name: string;
    qualifiedName: string | null;
    kind: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    exported: boolean;
    parameters: string | null;
}

/** Get all symbols in a specific file */
export function getFileSymbols(db: Database.Database, filePath: string): FileSymbolResult[] {
    const stmt = db.prepare(`
        SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.line_start as lineStart,
               s.line_end as lineEnd, s.signature, s.exported, s.parameters
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE f.path = ?
        ORDER BY s.line_start
    `);
    return stmt.all(filePath) as FileSymbolResult[];
}

/** Find symbols by kind (class, function, interface, type, enum, method, variable) */
export function findByKind(db: Database.Database, kind: string, limit: number = 50): SearchResult[] {
    const stmt = db.prepare(`
        SELECT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature,
               COALESCE(r.pagerank, 0) as pagerank
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE s.kind = ?
        ORDER BY r.pagerank DESC
        LIMIT ?
    `);
    return stmt.all(kind, limit) as SearchResult[];
}

export interface TypeHierarchyResult {
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
    relationKind: string;  // 'extends' or 'implements'
}

/** Find all classes/interfaces that extend or implement a given name */
export function getTypeHierarchy(db: Database.Database, parentName: string): TypeHierarchyResult[] {
    const stmt = db.prepare(`
        SELECT s.name, s.qualified_name as qualifiedName, s.kind, f.path as file,
               s.line_start as lineStart, tr.kind as relationKind
        FROM type_relations tr
        JOIN symbols s ON s.id = tr.child_id
        JOIN files f ON f.id = s.file_id
        WHERE tr.parent_name = ?
        ORDER BY tr.kind, s.name
    `);
    return stmt.all(parentName) as TypeHierarchyResult[];
}

export interface DeadExportResult {
    name: string;
    kind: string;
    file: string;
    lineStart: number;
}

/** Find exported symbols that nothing references or imports */
export function findDeadExports(db: Database.Database, limit: number = 50): DeadExportResult[] {
    const stmt = db.prepare(`
        SELECT s.name, s.kind, f.path as file, s.line_start as lineStart
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE s.exported = 1
          AND s.kind != 'reexport'
          AND NOT EXISTS (
              SELECT 1 FROM edges e WHERE e.to_id = s.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM file_deps fd
              WHERE fd.to_file = s.file_id
                AND (fd.import_name LIKE '%' || s.name || '%' OR fd.import_name = '*')
          )
        ORDER BY f.path, s.line_start
        LIMIT ?
    `);
    return stmt.all(limit) as DeadExportResult[];
}

export interface PkgUsageResult {
    file: string;
    importedNames: string;
}

/** Find all files that import from a given package */
export function getPkgUsages(db: Database.Database, packageName: string): PkgUsageResult[] {
    const stmt = db.prepare(`
        SELECT f.path as file, pd.imported_names as importedNames
        FROM pkg_deps pd
        JOIN files f ON f.id = pd.file_id
        WHERE pd.package = ? OR pd.package LIKE ? || '/%'
        ORDER BY f.path
    `);
    return stmt.all(packageName, packageName) as PkgUsageResult[];
}

// --- review_diff types ---

interface DiffHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
}

interface DiffFile {
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    oldPath?: string;
    hunks: DiffHunk[];
    addedLines: number;
    deletedLines: number;
}

export interface ChangedSymbol {
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    exported: boolean;
    pagerank: number;
    hunkOverlap: 'full' | 'partial';
}

export interface AffectedDependent {
    symbolName: string;
    symbolFile: string;
    dependentName: string;
    dependentFile: string;
    dependentKind: string;
    dependentPagerank: number;
}

export interface FileReviewContext {
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    oldPath?: string;
    addedLines: number;
    deletedLines: number;
    changedSymbols: ChangedSymbol[];
    unchangedExports: string[];
}

export interface ReviewDiffResult {
    summary: {
        target: string;
        filesChanged: number;
        filesAdded: number;
        filesDeleted: number;
        totalAdded: number;
        totalDeleted: number;
        symbolsModified: number;
        highRiskSymbols: number;
        impactedFiles: number;
    };
    diff: string;
    files: FileReviewContext[];
    affectedDependents: AffectedDependent[];
    transitiveImpact: ImpactResult[];
    risks: string[];
}

// --- review_diff helpers ---

function getGitDiff(rootDir: string, target: string): string {
    const opts = { cwd: rootDir, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' as const };
    try {
        switch (target) {
            case 'staged':
                return execSync('git diff --cached', opts);
            case 'last_commit':
                return execSync('git diff HEAD~1 HEAD', opts);
            case 'branch': {
                let baseBranch = 'main';
                try { execSync('git rev-parse --verify main', { ...opts, stdio: 'pipe' }); }
                catch { baseBranch = 'master'; }
                const mergeBase = execSync(`git merge-base ${baseBranch} HEAD`, opts).trim();
                return execSync(`git diff ${mergeBase} HEAD`, opts);
            }
            default:
                return execSync(`git diff ${target}~1 ${target}`, opts);
        }
    } catch (err: any) {
        throw new Error(`git diff failed for target "${target}": ${err.message}`);
    }
}

function parseDiff(rawDiff: string): DiffFile[] {
    const files: DiffFile[] = [];
    const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

    for (const section of fileSections) {
        const lines = section.split('\n');
        const headerMatch = lines[0].match(/a\/(.+?)\s+b\/(.+)/);
        if (!headerMatch) continue;

        const oldPath = headerMatch[1];
        const newPath = headerMatch[2];

        let status: DiffFile['status'] = 'modified';
        if (section.includes('new file mode')) status = 'added';
        else if (section.includes('deleted file mode')) status = 'deleted';
        else if (section.includes('rename from')) status = 'renamed';

        const hunks: DiffHunk[] = [];
        let addedLines = 0;
        let deletedLines = 0;
        const hunkRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

        for (const line of lines) {
            const hunkMatch = line.match(hunkRegex);
            if (hunkMatch) {
                hunks.push({
                    oldStart: parseInt(hunkMatch[1], 10),
                    oldCount: parseInt(hunkMatch[2] ?? '1', 10),
                    newStart: parseInt(hunkMatch[3], 10),
                    newCount: parseInt(hunkMatch[4] ?? '1', 10),
                });
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
                addedLines++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                deletedLines++;
            }
        }

        files.push({
            path: status === 'deleted' ? oldPath : newPath,
            status,
            oldPath: status === 'renamed' ? oldPath : undefined,
            hunks,
            addedLines,
            deletedLines,
        });
    }
    return files;
}

function matchHunksToSymbols(
    db: Database.Database,
    diffFile: DiffFile
): { changed: ChangedSymbol[]; unchangedExports: string[] } {
    const allSymbols = db.prepare(`
        SELECT s.name, s.qualified_name, s.kind, f.path as file,
               s.line_start, s.line_end, s.signature, s.exported,
               COALESCE(r.pagerank, 0) as pagerank
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        LEFT JOIN rankings r ON r.symbol_id = s.id
        WHERE f.path = ?
        ORDER BY s.line_start
    `).all(diffFile.path) as any[];

    if (allSymbols.length === 0) {
        return { changed: [], unchangedExports: [] };
    }

    const mapSym = (s: any, overlap: 'full' | 'partial'): ChangedSymbol => ({
        name: s.name,
        qualifiedName: s.qualified_name,
        kind: s.kind,
        file: s.file,
        lineStart: s.line_start,
        lineEnd: s.line_end,
        signature: s.signature,
        exported: !!s.exported,
        pagerank: s.pagerank,
        hunkOverlap: overlap,
    });

    if (diffFile.status === 'added' || diffFile.status === 'deleted') {
        return {
            changed: allSymbols.map((s: any) => mapSym(s, 'full')),
            unchangedExports: [],
        };
    }

    // Modified/renamed: check hunk overlap with symbol line ranges
    const changedRanges = diffFile.hunks.map(h => ({
        start: h.newStart,
        end: h.newStart + h.newCount - 1,
    }));

    const changed: ChangedSymbol[] = [];
    const unchangedExports: string[] = [];

    for (const sym of allSymbols) {
        const symStart = sym.line_start;
        const symEnd = sym.line_end;
        let overlaps = false;
        let fullyContained = false;

        for (const range of changedRanges) {
            if (symEnd >= range.start && symStart <= range.end) {
                overlaps = true;
                if (range.start <= symStart && range.end >= symEnd) {
                    fullyContained = true;
                }
            }
        }

        if (overlaps) {
            changed.push(mapSym(sym, fullyContained ? 'full' : 'partial'));
        } else if (sym.exported) {
            unchangedExports.push(`${sym.name} [${sym.kind}]`);
        }
    }

    return { changed, unchangedExports };
}

function getMedianPagerank(db: Database.Database): number {
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM rankings').get() as any)?.cnt || 0;
    if (count === 0) return 0;
    const mid = Math.floor(count / 2);
    const row = db.prepare('SELECT pagerank FROM rankings ORDER BY pagerank LIMIT 1 OFFSET ?').get(mid) as any;
    return row?.pagerank || 0;
}

// --- review_diff main function ---

export function reviewDiff(
    db: Database.Database,
    rootDir: string,
    target: string = 'last_commit'
): ReviewDiffResult {
    const rawDiff = getGitDiff(rootDir, target);

    if (!rawDiff.trim()) {
        return {
            summary: {
                target, filesChanged: 0, filesAdded: 0, filesDeleted: 0,
                totalAdded: 0, totalDeleted: 0, symbolsModified: 0,
                highRiskSymbols: 0, impactedFiles: 0,
            },
            diff: '',
            files: [],
            affectedDependents: [],
            transitiveImpact: [],
            risks: ['No changes found for this target.'],
        };
    }

    const diffFiles = parseDiff(rawDiff);

    // Match hunks to symbols per file
    const fileContexts: FileReviewContext[] = [];
    const allChangedSymbols: ChangedSymbol[] = [];

    for (const df of diffFiles) {
        const { changed, unchangedExports } = matchHunksToSymbols(db, df);
        allChangedSymbols.push(...changed);
        fileContexts.push({
            path: df.path,
            status: df.status,
            oldPath: df.oldPath,
            addedLines: df.addedLines,
            deletedLines: df.deletedLines,
            changedSymbols: changed,
            unchangedExports,
        });
    }

    // Get callers of changed exported symbols (cross-file only)
    const affectedDependents: AffectedDependent[] = [];
    const seenDeps = new Set<string>();

    for (const sym of allChangedSymbols) {
        if (!sym.exported) continue;
        const callers = getCallers(db, sym.qualifiedName || sym.name);
        for (const caller of callers) {
            if (caller.file === sym.file) continue;
            const key = `${sym.name}:${caller.name}:${caller.file}`;
            if (seenDeps.has(key)) continue;
            seenDeps.add(key);
            affectedDependents.push({
                symbolName: sym.qualifiedName || sym.name,
                symbolFile: sym.file,
                dependentName: caller.qualifiedName || caller.name,
                dependentFile: caller.file,
                dependentKind: caller.kind,
                dependentPagerank: caller.pagerank,
            });
        }
    }

    affectedDependents.sort((a, b) => b.dependentPagerank - a.dependentPagerank);

    // Transitive file impact
    const transitiveImpact: ImpactResult[] = [];
    const impactedFileSet = new Set<string>();

    for (const df of diffFiles) {
        if (df.status === 'deleted') continue;
        const impact = getImpact(db, df.path, 3);
        for (const imp of impact) {
            if (!impactedFileSet.has(imp.file)) {
                impactedFileSet.add(imp.file);
                transitiveImpact.push(imp);
            }
        }
    }

    // Risk assessment
    const risks: string[] = [];
    const medianPagerank = getMedianPagerank(db);
    const highRankSymbols = allChangedSymbols.filter(s => s.pagerank > medianPagerank && medianPagerank > 0);

    if (highRankSymbols.length > 0) {
        risks.push(
            `${highRankSymbols.length} high-importance symbol(s) modified: ` +
            highRankSymbols.slice(0, 5).map(s => `${s.name} (rank=${s.pagerank.toFixed(6)})`).join(', ')
        );
    }

    for (const sym of allChangedSymbols) {
        if (!sym.exported) continue;
        const depCount = affectedDependents.filter(d => d.symbolName === (sym.qualifiedName || sym.name)).length;
        if (depCount >= 5) {
            risks.push(`${sym.name} is exported and has ${depCount} callers in other files — changes may cascade.`);
        }
    }

    if (transitiveImpact.length > 20) {
        risks.push(`Large transitive impact: ${transitiveImpact.length} files could be affected.`);
    }

    for (const df of diffFiles) {
        if (df.status !== 'deleted') continue;
        const impact = getImpact(db, df.path, 1);
        if (impact.length > 0) {
            risks.push(`Deleted file ${df.path} still has ${impact.length} dependent file(s) — potential broken imports.`);
        }
    }

    // Truncate diff if very large
    const diffLines = rawDiff.split('\n');
    const truncatedDiff = diffLines.length > 5000
        ? diffLines.slice(0, 5000).join('\n') + `\n... (truncated, ${diffLines.length - 5000} more lines)`
        : rawDiff;

    return {
        summary: {
            target,
            filesChanged: diffFiles.filter(f => f.status === 'modified').length,
            filesAdded: diffFiles.filter(f => f.status === 'added').length,
            filesDeleted: diffFiles.filter(f => f.status === 'deleted').length,
            totalAdded: diffFiles.reduce((sum, f) => sum + f.addedLines, 0),
            totalDeleted: diffFiles.reduce((sum, f) => sum + f.deletedLines, 0),
            symbolsModified: allChangedSymbols.length,
            highRiskSymbols: highRankSymbols.length,
            impactedFiles: transitiveImpact.length,
        },
        diff: truncatedDiff,
        files: fileContexts,
        affectedDependents: affectedDependents.slice(0, 50),
        transitiveImpact: transitiveImpact.slice(0, 30),
        risks,
    };
}

// --- transparent_review: plain-English, zero-black-box code review ---

interface SymbolBeforeAfter {
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    exported: boolean;
    pagerank: number;
    hunkOverlap: 'full' | 'partial';
    beforeCode: string | null;
    afterCode: string | null;
    diffSnippet: string;
}

interface CallerStory {
    callerName: string;
    callerFile: string;
    callerKind: string;
    callerPagerank: number;
    callerSignature: string | null;
    callerCode: string | null;
    changedSymbol: string;
    changedFile: string;
}

function getFileAtRef(rootDir: string, filePath: string, ref: string): string | null {
    try {
        return execSync(`git show ${ref}:${filePath}`, {
            cwd: rootDir,
            maxBuffer: 5 * 1024 * 1024,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
        return null;
    }
}

function getGitRef(rootDir: string, target: string): string {
    const opts = { cwd: rootDir, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ('pipe')[] };
    switch (target) {
        case 'staged':
        case 'last_commit':
            return 'HEAD~1';
        case 'branch': {
            let baseBranch = 'main';
            try { execSync('git rev-parse --verify main', opts); }
            catch { baseBranch = 'master'; }
            return execSync(`git merge-base ${baseBranch} HEAD`, opts).trim();
        }
        default:
            return `${target}~1`;
    }
}

function extractSymbolCode(fileContent: string, lineStart: number, lineEnd: number): string {
    const lines = fileContent.split('\n');
    return lines.slice(lineStart - 1, lineEnd).join('\n');
}

function findSymbolInOldFile(oldContent: string, symbolName: string, kind: string): string | null {
    // Try to find the symbol definition in the old file by matching typical patterns
    const lines = oldContent.split('\n');
    const escapedName = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Build patterns based on symbol kind
    const patterns: RegExp[] = [];
    if (kind === 'function') {
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapedName}\\b`));
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapedName}\\s*=`));
    } else if (kind === 'class') {
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${escapedName}\\b`));
    } else if (kind === 'interface') {
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?interface\\s+${escapedName}\\b`));
    } else if (kind === 'type') {
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?type\\s+${escapedName}\\b`));
    } else if (kind === 'method') {
        const methodName = symbolName.includes('.') ? symbolName.split('.').pop()! : symbolName;
        const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        patterns.push(new RegExp(`^\\s*(?:async\\s+)?${escaped}\\s*\\(`));
        patterns.push(new RegExp(`^\\s*(?:public|private|protected)?\\s*(?:async\\s+)?${escaped}\\s*\\(`));
    } else if (kind === 'variable') {
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapedName}\\b`));
    } else if (kind === 'enum') {
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?enum\\s+${escapedName}\\b`));
    }
    // Fallback: just look for the name
    patterns.push(new RegExp(`\\b${escapedName}\\b`));

    for (const pattern of patterns) {
        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                // Found start, now find end by tracking braces
                const startLine = i;
                let braceDepth = 0;
                let foundOpenBrace = false;
                let endLine = i;

                for (let j = i; j < lines.length; j++) {
                    for (const ch of lines[j]) {
                        if (ch === '{') { braceDepth++; foundOpenBrace = true; }
                        else if (ch === '}') { braceDepth--; }
                    }
                    endLine = j;
                    if (foundOpenBrace && braceDepth <= 0) break;
                    // For single-line declarations without braces
                    if (!foundOpenBrace && j > i && !lines[j + 1]?.match(/^\s/)) break;
                }

                return lines.slice(startLine, endLine + 1).join('\n');
            }
        }
    }

    return null;
}

function extractDiffForRange(rawDiff: string, filePath: string, lineStart: number, lineEnd: number): string {
    // Find the diff section for this file
    const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);
    for (const section of fileSections) {
        if (!section.includes(filePath)) continue;

        const lines = section.split('\n');
        const result: string[] = [];
        let inRelevantHunk = false;
        let currentNewLine = 0;
        const hunkRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

        for (const line of lines) {
            const hunkMatch = line.match(hunkRegex);
            if (hunkMatch) {
                currentNewLine = parseInt(hunkMatch[3], 10);
                const newCount = parseInt(hunkMatch[4] ?? '1', 10);
                const hunkEnd = currentNewLine + newCount - 1;
                // Check if this hunk overlaps with symbol range
                inRelevantHunk = (hunkEnd >= lineStart && currentNewLine <= lineEnd);
                if (inRelevantHunk) {
                    result.push(line);
                }
                continue;
            }

            if (inRelevantHunk) {
                if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                    if (!line.startsWith('-')) currentNewLine++;
                    // Only include lines within or near the symbol range
                    if (currentNewLine >= lineStart - 2 && currentNewLine <= lineEnd + 2) {
                        result.push(line);
                    } else if (line.startsWith('+') || line.startsWith('-')) {
                        // Always include actual changes
                        result.push(line);
                    }
                }
            }
        }

        if (result.length > 0) return result.join('\n');
    }
    return '';
}

function describeChange(sym: SymbolBeforeAfter): string {
    const parts: string[] = [];

    if (!sym.beforeCode && sym.afterCode) {
        parts.push(`New ${sym.kind} added.`);
        if (sym.exported) parts.push('It is exported — other files can import it.');
        if (sym.signature) parts.push(`Signature: ${sym.signature}`);
        return parts.join(' ');
    }

    if (sym.beforeCode && !sym.afterCode) {
        parts.push(`This ${sym.kind} was deleted.`);
        if (sym.exported) parts.push('It was exported — anything importing it will break.');
        return parts.join(' ');
    }

    if (!sym.beforeCode || !sym.afterCode) {
        return `${sym.kind} was ${sym.hunkOverlap === 'full' ? 'fully rewritten' : 'partially modified'}.`;
    }

    const beforeLines = sym.beforeCode.split('\n');
    const afterLines = sym.afterCode.split('\n');
    const sizeDelta = afterLines.length - beforeLines.length;

    // Analyze what changed between before and after
    const beforeSig = beforeLines[0]?.trim() || '';
    const afterSig = afterLines[0]?.trim() || '';
    const sigChanged = beforeSig !== afterSig;

    // Detect parameter changes
    const paramRegex = /\(([^)]*)\)/;
    const beforeParams = beforeSig.match(paramRegex)?.[1] || '';
    const afterParams = afterSig.match(paramRegex)?.[1] || '';
    const paramsChanged = beforeParams !== afterParams;

    // Detect return type changes
    const retRegex = /\):\s*(.+?)[\s{]/;
    const beforeRet = beforeSig.match(retRegex)?.[1];
    const afterRet = afterSig.match(retRegex)?.[1];
    const retChanged = beforeRet !== afterRet && beforeRet && afterRet;

    if (sym.hunkOverlap === 'full') {
        parts.push(`Fully rewritten (${beforeLines.length} → ${afterLines.length} lines).`);
    } else {
        parts.push(`Partially modified.`);
        if (sizeDelta > 0) parts.push(`${sizeDelta} lines added.`);
        else if (sizeDelta < 0) parts.push(`${Math.abs(sizeDelta)} lines removed.`);
    }

    if (sigChanged) {
        parts.push(`Signature changed.`);
        if (paramsChanged) {
            const bCount = beforeParams ? beforeParams.split(',').length : 0;
            const aCount = afterParams ? afterParams.split(',').length : 0;
            if (aCount > bCount) parts.push(`${aCount - bCount} new parameter(s) added.`);
            else if (aCount < bCount) parts.push(`${bCount - aCount} parameter(s) removed.`);
            else parts.push('Parameter types/names changed.');
        }
    }

    if (retChanged) {
        parts.push(`Return type changed: ${beforeRet} → ${afterRet}.`);
    }

    // Detect new error handling
    const beforeHasTryCatch = /\btry\s*\{/.test(sym.beforeCode);
    const afterHasTryCatch = /\btry\s*\{/.test(sym.afterCode);
    if (!beforeHasTryCatch && afterHasTryCatch) parts.push('Added error handling (try/catch).');
    if (beforeHasTryCatch && !afterHasTryCatch) parts.push('Removed error handling (try/catch).');

    // Detect async changes
    const wasAsync = /\basync\b/.test(sym.beforeCode);
    const isAsync = /\basync\b/.test(sym.afterCode);
    if (!wasAsync && isAsync) parts.push('Now async.');
    if (wasAsync && !isAsync) parts.push('No longer async.');

    // Detect new conditionals
    const beforeIfs = (sym.beforeCode.match(/\bif\s*\(/g) || []).length;
    const afterIfs = (sym.afterCode.match(/\bif\s*\(/g) || []).length;
    if (afterIfs > beforeIfs) parts.push(`${afterIfs - beforeIfs} new conditional branch(es).`);
    if (afterIfs < beforeIfs) parts.push(`${beforeIfs - afterIfs} conditional branch(es) removed.`);

    // Detect loop changes
    const beforeLoops = (sym.beforeCode.match(/\b(for|while|forEach)\b/g) || []).length;
    const afterLoops = (sym.afterCode.match(/\b(for|while|forEach)\b/g) || []).length;
    if (afterLoops > beforeLoops) parts.push(`${afterLoops - beforeLoops} new loop(s).`);
    if (afterLoops < beforeLoops) parts.push(`${beforeLoops - afterLoops} loop(s) removed.`);

    return parts.join(' ');
}

function describeCallerImpact(caller: CallerStory, sym: SymbolBeforeAfter): string {
    const parts: string[] = [];
    parts.push(`${caller.callerName} (${caller.callerKind} in ${caller.callerFile})`);
    parts.push(`calls ${sym.qualifiedName || sym.name}.`);

    if (!sym.beforeCode && sym.afterCode) {
        parts.push('This is a new symbol — caller was just added or is using new functionality.');
    } else if (sym.beforeCode && !sym.afterCode) {
        parts.push('This symbol was DELETED — this caller WILL BREAK.');
    } else {
        // Check if signature changed
        const beforeSig = sym.beforeCode?.split('\n')[0]?.trim() || '';
        const afterSig = sym.afterCode?.split('\n')[0]?.trim() || '';
        if (beforeSig !== afterSig) {
            parts.push(`Signature changed, so this caller may need updating.`);
        } else {
            parts.push('Signature unchanged — caller compiles fine, but behavior changed.');
        }
    }

    return parts.join(' ');
}

export function transparentReview(
    db: Database.Database,
    rootDir: string,
    target: string = 'last_commit'
): string {
    const rawDiff = getGitDiff(rootDir, target);

    if (!rawDiff.trim()) {
        return '# Transparent Review\n\nNo changes found for target: ' + target;
    }

    const diffFiles = parseDiff(rawDiff);
    const gitRef = getGitRef(rootDir, target);
    const out: string[] = [];

    out.push(`# Transparent Review — ${target}`);
    out.push('');

    // Quick stats
    const added = diffFiles.filter(f => f.status === 'added').length;
    const modified = diffFiles.filter(f => f.status === 'modified').length;
    const deleted = diffFiles.filter(f => f.status === 'deleted').length;
    const renamed = diffFiles.filter(f => f.status === 'renamed').length;
    const totalAdded = diffFiles.reduce((s, f) => s + f.addedLines, 0);
    const totalDeleted = diffFiles.reduce((s, f) => s + f.deletedLines, 0);

    const statParts: string[] = [];
    if (modified) statParts.push(`${modified} modified`);
    if (added) statParts.push(`${added} added`);
    if (deleted) statParts.push(`${deleted} deleted`);
    if (renamed) statParts.push(`${renamed} renamed`);
    out.push(`**${diffFiles.length} file(s):** ${statParts.join(', ')} — +${totalAdded} / -${totalDeleted} lines`);
    out.push('');

    // --- Per-file breakdown with full transparency ---
    const allSymbolStories: SymbolBeforeAfter[] = [];

    out.push('---');
    out.push('## What Changed (file by file)');
    out.push('');

    for (const df of diffFiles) {
        out.push(`### \`${df.path}\` — ${df.status}`);
        if (df.oldPath) out.push(`  (renamed from \`${df.oldPath}\`)`);
        out.push(`  +${df.addedLines} / -${df.deletedLines} lines`);
        out.push('');

        // Get before and after file content
        const beforeFile = getFileAtRef(rootDir, df.oldPath || df.path, gitRef);
        let afterFile: string | null = null;
        if (df.status !== 'deleted') {
            try {
                const fs = require('fs');
                const fullPath = require('path').join(rootDir, df.path);
                afterFile = fs.readFileSync(fullPath, 'utf-8');
            } catch {
                // For committed changes, get from HEAD
                afterFile = getFileAtRef(rootDir, df.path, 'HEAD');
            }
        }

        // Match hunks to symbols
        const { changed, unchangedExports } = matchHunksToSymbols(db, df);

        if (changed.length === 0 && df.status === 'modified') {
            out.push('No tracked symbols changed (changes may be in whitespace, comments, or untracked code).');
            out.push('');
            continue;
        }

        for (const sym of changed) {
            // For before code: find by name in old file (line numbers shift between versions)
            const beforeCode = beforeFile
                ? findSymbolInOldFile(beforeFile, sym.qualifiedName?.split('.').pop() || sym.name, sym.kind)
                : null;
            const afterCode = afterFile
                ? extractSymbolCode(afterFile, sym.lineStart, sym.lineEnd)
                : null;
            const diffSnippet = extractDiffForRange(rawDiff, df.path, sym.lineStart, sym.lineEnd);

            const story: SymbolBeforeAfter = {
                ...sym,
                beforeCode: beforeCode && beforeCode.trim() ? beforeCode : null,
                afterCode: afterCode && afterCode.trim() ? afterCode : null,
                diffSnippet,
            };
            allSymbolStories.push(story);

            const exportTag = sym.exported ? ' (exported)' : '';
            out.push(`#### \`${sym.qualifiedName || sym.name}\` — ${sym.kind}${exportTag}`);
            out.push('');

            // Plain English description
            const desc = describeChange(story);
            out.push(`**What changed:** ${desc}`);
            out.push('');

            // Show before/after code
            if (story.beforeCode && story.afterCode) {
                out.push('<details><summary>Before</summary>');
                out.push('');
                out.push('```');
                out.push(story.beforeCode);
                out.push('```');
                out.push('</details>');
                out.push('');
                out.push('<details><summary>After</summary>');
                out.push('');
                out.push('```');
                out.push(story.afterCode);
                out.push('```');
                out.push('</details>');
                out.push('');
            } else if (story.afterCode) {
                out.push('**New code:**');
                out.push('```');
                out.push(story.afterCode.length > 1500
                    ? story.afterCode.slice(0, 1500) + '\n// ... truncated'
                    : story.afterCode);
                out.push('```');
                out.push('');
            } else if (story.beforeCode) {
                out.push('**Deleted code:**');
                out.push('```');
                out.push(story.beforeCode.length > 1500
                    ? story.beforeCode.slice(0, 1500) + '\n// ... truncated'
                    : story.beforeCode);
                out.push('```');
                out.push('');
            }

            // Show the exact diff lines for this symbol
            if (story.diffSnippet) {
                out.push('<details><summary>Diff</summary>');
                out.push('');
                out.push('```diff');
                out.push(story.diffSnippet);
                out.push('```');
                out.push('</details>');
                out.push('');
            }
        }

        if (unchangedExports.length > 0) {
            out.push(`**Unchanged exports:** ${unchangedExports.join(', ')}`);
            out.push('');
        }
    }

    // --- Caller Impact Stories ---
    out.push('---');
    out.push('## Who Gets Affected');
    out.push('');

    const exportedChanged = allSymbolStories.filter(s => s.exported);
    if (exportedChanged.length === 0) {
        out.push('No exported symbols were changed — impact is contained to the files above.');
        out.push('');
    } else {
        const callerStories: CallerStory[] = [];
        const seenCallers = new Set<string>();

        for (const sym of exportedChanged) {
            const callers = getCallers(db, sym.qualifiedName || sym.name);
            for (const caller of callers) {
                if (caller.file === sym.file) continue;
                const key = `${caller.name}:${caller.file}:${sym.name}`;
                if (seenCallers.has(key)) continue;
                seenCallers.add(key);

                // Get the caller's actual code so we can show context
                let callerCode: string | null = null;
                const callerCtx = getContext(db, caller.qualifiedName || caller.name);
                if (callerCtx) {
                    callerCode = callerCtx.symbol.code;
                }

                callerStories.push({
                    callerName: caller.qualifiedName || caller.name,
                    callerFile: caller.file,
                    callerKind: caller.kind,
                    callerPagerank: caller.pagerank,
                    callerSignature: caller.signature,
                    callerCode: callerCode && callerCode.length > 800
                        ? callerCode.slice(0, 800) + '\n// ... truncated'
                        : callerCode,
                    changedSymbol: sym.qualifiedName || sym.name,
                    changedFile: sym.file,
                });
            }
        }

        callerStories.sort((a, b) => b.callerPagerank - a.callerPagerank);

        if (callerStories.length === 0) {
            out.push('No cross-file callers found for the changed exports.');
            out.push('');
        } else {
            out.push(`**${callerStories.length} caller(s)** in other files use the changed exports:`);
            out.push('');

            for (const cs of callerStories.slice(0, 25)) {
                const sym = allSymbolStories.find(s =>
                    (s.qualifiedName || s.name) === cs.changedSymbol
                );
                if (!sym) continue;

                const impact = describeCallerImpact(cs, sym);
                out.push(`- **${cs.callerName}** in \`${cs.callerFile}\``);
                out.push(`  ${impact}`);

                if (cs.callerCode) {
                    out.push(`  <details><summary>Caller code</summary>`);
                    out.push('');
                    out.push('  ```');
                    out.push(cs.callerCode);
                    out.push('  ```');
                    out.push('  </details>');
                }
                out.push('');
            }

            if (callerStories.length > 25) {
                out.push(`... and ${callerStories.length - 25} more callers.`);
                out.push('');
            }
        }
    }

    // --- Transitive blast radius ---
    out.push('---');
    out.push('## Blast Radius');
    out.push('');

    const transitiveImpact: ImpactResult[] = [];
    const impactedFileSet = new Set<string>();

    for (const df of diffFiles) {
        if (df.status === 'deleted') continue;
        const impact = getImpact(db, df.path, 3);
        for (const imp of impact) {
            if (!impactedFileSet.has(imp.file)) {
                impactedFileSet.add(imp.file);
                transitiveImpact.push(imp);
            }
        }
    }

    if (transitiveImpact.length === 0) {
        out.push('No transitive file dependencies detected — these changes are self-contained.');
    } else {
        out.push(`**${transitiveImpact.length} file(s)** could be transitively affected:`);
        out.push('');

        // Group by depth
        const byDepth = new Map<number, ImpactResult[]>();
        for (const imp of transitiveImpact) {
            if (!byDepth.has(imp.depth)) byDepth.set(imp.depth, []);
            byDepth.get(imp.depth)!.push(imp);
        }

        for (const [depth, files] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
            const label = depth === 1 ? 'Direct importers' : `${depth} levels deep`;
            out.push(`**${label}** (${files.length} file${files.length > 1 ? 's' : ''}):`);
            for (const f of files.slice(0, 15)) {
                out.push(`  - \`${f.file}\` (${f.symbolCount} symbols)`);
            }
            if (files.length > 15) {
                out.push(`  - ... and ${files.length - 15} more`);
            }
            out.push('');
        }
    }

    // --- Risk Summary ---
    out.push('---');
    out.push('## Risk Summary');
    out.push('');

    const medianPagerank = getMedianPagerank(db);
    const risks: string[] = [];

    // High-importance symbols
    const highRank = allSymbolStories.filter(s => s.pagerank > medianPagerank && medianPagerank > 0);
    if (highRank.length > 0) {
        risks.push(`**High-importance code touched:** ${highRank.map(s => `\`${s.name}\` (rank #${s.pagerank.toFixed(6)})`).join(', ')} — these are among the most-referenced symbols in the project. Changes here ripple widely.`);
    }

    // Cascade risk
    for (const sym of exportedChanged) {
        const callerCount = allSymbolStories.length > 0
            ? getCallers(db, sym.qualifiedName || sym.name).filter(c => c.file !== sym.file).length
            : 0;
        if (callerCount >= 5) {
            risks.push(`**Cascade risk:** \`${sym.name}\` has ${callerCount} callers in other files. Behavioral changes will propagate to all of them.`);
        }
    }

    // Large blast radius
    if (transitiveImpact.length > 20) {
        risks.push(`**Wide blast radius:** ${transitiveImpact.length} files could be transitively affected. Consider testing downstream modules.`);
    }

    // Deleted files with dependents
    for (const df of diffFiles) {
        if (df.status !== 'deleted') continue;
        const impact = getImpact(db, df.path, 1);
        if (impact.length > 0) {
            risks.push(`**Broken imports likely:** Deleted \`${df.path}\` still has ${impact.length} file(s) importing from it: ${impact.slice(0, 5).map(i => `\`${i.file}\``).join(', ')}`);
        }
    }

    // Signature changes on exported symbols
    for (const sym of exportedChanged) {
        if (sym.beforeCode && sym.afterCode) {
            const bSig = sym.beforeCode.split('\n')[0]?.trim();
            const aSig = sym.afterCode.split('\n')[0]?.trim();
            if (bSig !== aSig) {
                risks.push(`**API change:** \`${sym.name}\` signature changed. Callers may need to update their call sites.`);
            }
        }
    }

    if (risks.length === 0) {
        out.push('No significant risks detected. Changes look contained and low-impact.');
    } else {
        for (const risk of risks) {
            out.push(`- ${risk}`);
        }
    }

    out.push('');
    return out.join('\n');
}

export function transparentReviewFromRoot(rootDir: string, target?: string): string {
    return withDb(rootDir, db => transparentReview(db, rootDir, target));
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

export function reviewDiffFromRoot(rootDir: string, target?: string): ReviewDiffResult {
    return withDb(rootDir, db => reviewDiff(db, rootDir, target));
}
