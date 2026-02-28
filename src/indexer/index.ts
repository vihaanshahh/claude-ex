import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
    openDatabase, getOrCreateFile, clearFileData,
    insertSymbol, insertEdge, insertFileDep, removeStaleFiles, removeFile
} from '../db/schema';
import { collectFiles } from './collector';
import { parseFile, hashFile, getLanguage } from './parser';

export interface IndexStats {
    totalFiles: number;
    indexedFiles: number;
    skippedFiles: number;
    symbols: number;
    edges: number;
    timeMs: number;
}

function resolveImportPath(rootDir: string, fromFile: string, importSource: string): string | null {
    // Skip non-relative imports (packages)
    if (!importSource.startsWith('.') && !importSource.startsWith('/')) return null;

    const fromDir = path.dirname(path.join(rootDir, fromFile));
    const resolved = path.resolve(fromDir, importSource);
    const rel = path.relative(rootDir, resolved);

    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', ''];
    const indexFiles = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

    // Try direct match with extensions
    for (const ext of extensions) {
        const candidate = rel + ext;
        if (fs.existsSync(path.join(rootDir, candidate))) return candidate;
    }

    // Try index files in directory
    for (const idx of indexFiles) {
        const candidate = rel + idx;
        if (fs.existsSync(path.join(rootDir, candidate))) return candidate;
    }

    return null;
}

export function indexProject(rootDir: string, options?: { verbose?: boolean }): IndexStats {
    const start = performance.now();
    const db = openDatabase(rootDir);
    const files = collectFiles(rootDir);
    const verbose = options?.verbose ?? false;

    let indexedFiles = 0;
    let skippedFiles = 0;
    let totalSymbols = 0;
    let totalEdges = 0;

    // Track file -> symbol IDs and file -> imported file paths
    const fileSymbolMap = new Map<string, Map<string, number>>(); // filePath -> (symbolName -> symbolId)
    const fileImportMap = new Map<string, { resolved: string; names: string[] }[]>();
    const validPaths = new Set(files);

    const transaction = db.transaction(() => {
        for (const relPath of files) {
            const fullPath = path.join(rootDir, relPath);
            let content: string;
            try {
                content = fs.readFileSync(fullPath, 'utf-8');
            } catch {
                skippedFiles++;
                continue;
            }

            const hash = hashFile(content);
            const language = getLanguage(relPath);
            const lineCount = content.split('\n').length;
            const fileRecord = getOrCreateFile(db, relPath, hash, language, lineCount);

            if (!fileRecord.changed) {
                skippedFiles++;
                // Still need to track existing symbols for cross-file resolution
                const existingSymbols = db.prepare(
                    'SELECT id, name, qualified_name, exported FROM symbols WHERE file_id = ?'
                ).all(fileRecord.id) as { id: number; name: string; qualified_name: string | null; exported: number }[];
                const symbolMap = new Map<string, number>();
                for (const s of existingSymbols) {
                    if (s.exported) {
                        symbolMap.set(s.name, s.id);
                        if (s.qualified_name) symbolMap.set(s.qualified_name, s.id);
                    }
                }
                fileSymbolMap.set(relPath, symbolMap);
                continue;
            }

            clearFileData(db, fileRecord.id);
            const parsed = parseFile(relPath, content);

            const symbolMap = new Map<string, number>();

            for (const sym of parsed.symbols) {
                const symId = insertSymbol(db, fileRecord.id, {
                    name: sym.name,
                    qualifiedName: sym.qualifiedName,
                    kind: sym.kind,
                    lineStart: sym.lineStart,
                    lineEnd: sym.lineEnd,
                    signature: sym.signature,
                    docstring: sym.docstring,
                    content: sym.content,
                    exported: sym.exported,
                });
                symbolMap.set(sym.name, symId);
                if (sym.qualifiedName) symbolMap.set(sym.qualifiedName, symId);
                totalSymbols++;
            }

            fileSymbolMap.set(relPath, symbolMap);

            // Resolve imports to file paths
            const resolvedImports: { resolved: string; names: string[] }[] = [];
            for (const imp of parsed.imports) {
                const resolved = resolveImportPath(rootDir, relPath, imp.source);
                if (resolved) {
                    // Create file dep
                    const toFile = db.prepare('SELECT id FROM files WHERE path = ?').get(resolved) as { id: number } | undefined;
                    if (toFile) {
                        const importName = imp.names.length > 0 ? imp.names.join(',') : '*';
                        insertFileDep(db, fileRecord.id, toFile.id, 'import', importName);
                    }
                    resolvedImports.push({ resolved, names: imp.names });
                }
            }
            fileImportMap.set(relPath, resolvedImports);

            // Create intra-file call edges
            for (const call of parsed.calls) {
                const callerId = symbolMap.get(call.callerSymbol);
                const calledId = symbolMap.get(call.calledName);
                if (callerId && calledId && callerId !== calledId) {
                    insertEdge(db, callerId, calledId, 'calls');
                    totalEdges++;
                }
            }

            indexedFiles++;
            if (verbose && indexedFiles % 100 === 0) {
                process.stderr.write(`  Indexed ${indexedFiles} files...\n`);
            }
        }

        // Remove stale files
        removeStaleFiles(db, validPaths);

        // Cross-file edge resolution
        for (const [filePath, resolvedImports] of fileImportMap) {
            const importingSymbols = fileSymbolMap.get(filePath);
            if (!importingSymbols) continue;

            for (const imp of resolvedImports) {
                const exportedSymbols = fileSymbolMap.get(imp.resolved);
                if (!exportedSymbols) continue;

                for (const importedName of imp.names) {
                    const targetId = exportedSymbols.get(importedName);
                    if (targetId) {
                        // Create REFERENCES edges from all symbols in importing file to imported symbol
                        for (const [, srcId] of importingSymbols) {
                            if (srcId !== targetId) {
                                insertEdge(db, srcId, targetId, 'references');
                                totalEdges++;
                            }
                        }
                    }
                }
            }
        }
    });

    transaction();

    // Compute PageRank
    computePageRank(db);

    db.close();

    return {
        totalFiles: files.length,
        indexedFiles,
        skippedFiles,
        symbols: totalSymbols,
        edges: totalEdges,
        timeMs: performance.now() - start,
    };
}

export function reindexFile(rootDir: string, relPath: string, db?: Database.Database): void {
    const shouldClose = !db;
    if (!db) db = openDatabase(rootDir);

    const fullPath = path.join(rootDir, relPath);

    if (!fs.existsSync(fullPath)) {
        removeFile(db, relPath);
        if (shouldClose) db.close();
        return;
    }

    let content: string;
    try {
        content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
        if (shouldClose) db.close();
        return;
    }

    const hash = hashFile(content);
    const language = getLanguage(relPath);
    const lineCount = content.split('\n').length;
    const fileRecord = getOrCreateFile(db, relPath, hash, language, lineCount);

    if (!fileRecord.changed) {
        if (shouldClose) db.close();
        return;
    }

    clearFileData(db, fileRecord.id);
    const parsed = parseFile(relPath, content);

    const symbolMap = new Map<string, number>();
    for (const sym of parsed.symbols) {
        const symId = insertSymbol(db, fileRecord.id, {
            name: sym.name,
            qualifiedName: sym.qualifiedName,
            kind: sym.kind,
            lineStart: sym.lineStart,
            lineEnd: sym.lineEnd,
            signature: sym.signature,
            docstring: sym.docstring,
            content: sym.content,
            exported: sym.exported,
        });
        symbolMap.set(sym.name, symId);
        if (sym.qualifiedName) symbolMap.set(sym.qualifiedName, symId);
    }

    // Resolve imports
    for (const imp of parsed.imports) {
        const resolved = resolveImportPath(rootDir, relPath, imp.source);
        if (resolved) {
            const toFile = db.prepare('SELECT id FROM files WHERE path = ?').get(resolved) as { id: number } | undefined;
            if (toFile) {
                insertFileDep(db, fileRecord.id, toFile.id, 'import', imp.names.join(',') || '*');
            }
        }
    }

    // Intra-file call edges
    for (const call of parsed.calls) {
        const callerId = symbolMap.get(call.callerSymbol);
        const calledId = symbolMap.get(call.calledName);
        if (callerId && calledId && callerId !== calledId) {
            insertEdge(db, callerId, calledId, 'calls');
        }
    }

    if (shouldClose) db.close();
}

function computePageRank(db: Database.Database, iterations: number = 20, damping: number = 0.85): void {
    const symbols = db.prepare('SELECT id FROM symbols').all() as { id: number }[];
    if (symbols.length === 0) return;

    const n = symbols.length;
    const idToIdx = new Map<number, number>();
    const ids: number[] = [];

    for (let i = 0; i < symbols.length; i++) {
        idToIdx.set(symbols[i].id, i);
        ids.push(symbols[i].id);
    }

    const edges = db.prepare('SELECT from_id, to_id FROM edges').all() as { from_id: number; to_id: number }[];

    // Build adjacency: outgoing[i] = [j, k, ...] means i links to j, k
    const outgoing: number[][] = new Array(n).fill(null).map(() => []);
    const incoming: number[][] = new Array(n).fill(null).map(() => []);
    const outDegree = new Array(n).fill(0);
    const inDegree = new Array(n).fill(0);

    for (const edge of edges) {
        const from = idToIdx.get(edge.from_id);
        const to = idToIdx.get(edge.to_id);
        if (from !== undefined && to !== undefined) {
            outgoing[from].push(to);
            incoming[to].push(from);
            outDegree[from]++;
            inDegree[to]++;
        }
    }

    // PageRank iteration
    let rank = new Float64Array(n).fill(1 / n);
    let newRank = new Float64Array(n);

    for (let iter = 0; iter < iterations; iter++) {
        newRank.fill((1 - damping) / n);
        for (let i = 0; i < n; i++) {
            if (outDegree[i] > 0) {
                const share = rank[i] / outDegree[i];
                for (const j of outgoing[i]) {
                    newRank[j] += damping * share;
                }
            } else {
                // Distribute dangling node's rank
                const share = rank[i] / n;
                for (let j = 0; j < n; j++) {
                    newRank[j] += damping * share;
                }
            }
        }
        [rank, newRank] = [newRank, rank];
    }

    // Write rankings
    db.prepare('DELETE FROM rankings').run();
    const insertRank = db.prepare(
        'INSERT INTO rankings (symbol_id, pagerank, in_degree, out_degree) VALUES (?, ?, ?, ?)'
    );
    const writeRankings = db.transaction(() => {
        for (let i = 0; i < n; i++) {
            insertRank.run(ids[i], rank[i], inDegree[i], outDegree[i]);
        }
    });
    writeRankings();
}
