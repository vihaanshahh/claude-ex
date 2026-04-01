import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
    openDatabase, getOrCreateFile, clearFileData,
    insertSymbol, insertEdge, insertFileDep, insertPkgDep, insertTypeRelation,
    removeStaleFiles, removeFile
} from '../db/schema';
import { collectFiles, MAX_FILE_SIZE } from './collector';
import { parseFile, hashFile, getLanguage } from './parser';
import { countLines } from '../utils';

export interface IndexStats {
    totalFiles: number;
    indexedFiles: number;
    skippedFiles: number;
    symbols: number;
    edges: number;
    timeMs: number;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', ''];
const RESOLVE_INDEX_FILES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function resolveImportPath(rootDir: string, fromFile: string, importSource: string, knownFiles?: Set<string>): string | null {
    if (!importSource.startsWith('.') && !importSource.startsWith('/')) return null;

    const fromDir = path.dirname(path.join(rootDir, fromFile));
    const resolved = path.resolve(fromDir, importSource);
    const rel = path.relative(rootDir, resolved);

    // Fast path: use pre-computed file set (no fs.existsSync calls)
    if (knownFiles) {
        for (const ext of RESOLVE_EXTENSIONS) {
            const candidate = rel + ext;
            if (knownFiles.has(candidate)) return candidate;
        }
        for (const idx of RESOLVE_INDEX_FILES) {
            const candidate = rel + idx;
            if (knownFiles.has(candidate)) return candidate;
        }
        return null;
    }

    // Slow path: filesystem check (used by reindexFile for single files)
    for (const ext of RESOLVE_EXTENSIONS) {
        const candidate = rel + ext;
        if (fs.existsSync(path.join(rootDir, candidate))) return candidate;
    }
    for (const idx of RESOLVE_INDEX_FILES) {
        const candidate = rel + idx;
        if (fs.existsSync(path.join(rootDir, candidate))) return candidate;
    }
    return null;
}

function isPackageImport(source: string): boolean {
    return !source.startsWith('.') && !source.startsWith('/');
}

function getFileMtime(fullPath: string): number | undefined {
    try {
        return fs.statSync(fullPath).mtimeMs;
    } catch {
        return undefined;
    }
}

export function indexProject(rootDir: string, options?: { verbose?: boolean; work?: boolean }): IndexStats {
    const start = performance.now();
    const db = openDatabase(rootDir, options?.work);
    const files = collectFiles(rootDir);
    const verbose = options?.verbose ?? false;

    let indexedFiles = 0;
    let skippedFiles = 0;
    let totalSymbols = 0;
    let totalEdges = 0;

    // Track file -> symbol IDs and file -> imported file paths
    const fileSymbolMap = new Map<string, Map<string, number>>(); // filePath -> (symbolName -> symbolId)
    const fileImportMap = new Map<string, { resolved: string; names: string[] }[]>();
    // Track which symbols call a given name per file: "filePath:calledName" -> Set<callerId>
    const callTargetToCallers = new Map<string, Set<number>>();
    const validPaths = new Set(files);

    const lookupFileStmt = db.prepare('SELECT id FROM files WHERE path = ?');
    const lookupExistingSymsStmt = db.prepare(
        'SELECT id, name, qualified_name, exported FROM symbols WHERE file_id = ?'
    );

    // Pre-read all files and create file records so import resolution works
    // regardless of alphabetical processing order.
    interface FileInfo {
        relPath: string;
        content: string;
        fileId: number;
        changed: boolean;
    }
    const fileInfos: FileInfo[] = [];

    const transaction = db.transaction(() => {
        // Pass 1: create/update all file records
        for (const relPath of files) {
            const fullPath = path.join(rootDir, relPath);
            let content: string;
            try {
                const buf = fs.readFileSync(fullPath);
                if (buf.length > MAX_FILE_SIZE) {
                    skippedFiles++;
                    continue;
                }
                content = buf.toString('utf-8');
            } catch {
                skippedFiles++;
                continue;
            }

            const hash = hashFile(content);
            const language = getLanguage(relPath);
            const lineCount = countLines(content);
            const mtime = getFileMtime(fullPath);
            const fileRecord = getOrCreateFile(db, relPath, hash, language, lineCount, mtime);
            fileInfos.push({ relPath, content, fileId: fileRecord.id, changed: fileRecord.changed });
        }

        // Pass 2: parse changed files, resolve imports (all file records now exist)
        for (const { relPath, content, fileId, changed } of fileInfos) {
            if (!changed) {
                skippedFiles++;
                // Still need to track existing symbols for cross-file resolution
                const existingSymbols = lookupExistingSymsStmt.all(fileId) as { id: number; name: string; qualified_name: string | null; exported: number }[];
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

            clearFileData(db, fileId);
            const parsed = parseFile(relPath, content);

            const symbolMap = new Map<string, number>();

            for (const sym of parsed.symbols) {
                const symId = insertSymbol(db, fileId, {
                    name: sym.name,
                    qualifiedName: sym.qualifiedName,
                    kind: sym.kind,
                    lineStart: sym.lineStart,
                    lineEnd: sym.lineEnd,
                    signature: sym.signature,
                    docstring: sym.docstring,
                    content: sym.content,
                    exported: sym.exported,
                    parameters: sym.parameters ? JSON.stringify(sym.parameters) : undefined,
                });
                symbolMap.set(sym.name, symId);
                if (sym.qualifiedName) symbolMap.set(sym.qualifiedName, symId);
                totalSymbols++;

                // Store type relations (extends/implements)
                if (sym.extends) {
                    for (const parent of sym.extends) {
                        insertTypeRelation(db, symId, parent, 'extends');
                    }
                }
                if (sym.implements) {
                    for (const iface of sym.implements) {
                        insertTypeRelation(db, symId, iface, 'implements');
                    }
                }
            }

            fileSymbolMap.set(relPath, symbolMap);

            // Create re-export pseudo-symbols so barrel files show their exports
            for (const reExport of parsed.reExports) {
                for (const name of reExport.names) {
                    if (!symbolMap.has(name)) {
                        const symId = insertSymbol(db, fileId, {
                            name,
                            kind: 'reexport',
                            lineStart: 0,
                            lineEnd: 0,
                            signature: `export { ${name} } from '${reExport.source}'`,
                            exported: true,
                        });
                        symbolMap.set(name, symId);
                        totalSymbols++;
                    }
                }
            }

            // Resolve imports to file paths — all file records exist now
            const resolvedImports: { resolved: string; names: string[] }[] = [];
            for (const imp of parsed.imports) {
                if (isPackageImport(imp.source)) {
                    // Third-party import — store in pkg_deps
                    const names = imp.names.length > 0 ? imp.names.join(',') : imp.isDefault ? 'default' : '*';
                    insertPkgDep(db, fileId, imp.source, names);
                    continue;
                }

                const resolved = resolveImportPath(rootDir, relPath, imp.source, validPaths);
                if (resolved) {
                    const toFile = lookupFileStmt.get(resolved) as { id: number } | undefined;
                    if (toFile) {
                        const importName = imp.names.length > 0 ? imp.names.join(',') : '*';
                        insertFileDep(db, fileId, toFile.id, 'import', importName);
                    }
                    resolvedImports.push({ resolved, names: imp.names });
                }
            }
            fileImportMap.set(relPath, resolvedImports);

            // Create intra-file call edges (with line numbers)
            for (const call of parsed.calls) {
                const callerId = symbolMap.get(call.callerSymbol);
                const calledId = symbolMap.get(call.calledName);
                if (callerId && calledId && callerId !== calledId) {
                    insertEdge(db, callerId, calledId, 'calls', call.line);
                    totalEdges++;
                }
                // Track caller->calledName for cross-file edge resolution
                if (callerId) {
                    const key = `${relPath}:${call.calledName}`;
                    let set = callTargetToCallers.get(key);
                    if (!set) { set = new Set(); callTargetToCallers.set(key, set); }
                    set.add(callerId);
                }
            }

            indexedFiles++;
            if (verbose && indexedFiles % 100 === 0) {
                process.stderr.write(`  Indexed ${indexedFiles} files...\n`);
            }
        }

        // Remove stale files
        removeStaleFiles(db, validPaths);

        // Cross-file edge resolution — only link symbols that actually use the import
        for (const [filePath, resolvedImports] of fileImportMap) {
            const importingSymbols = fileSymbolMap.get(filePath);
            if (!importingSymbols) continue;

            for (const imp of resolvedImports) {
                const exportedSymbols = fileSymbolMap.get(imp.resolved);
                if (!exportedSymbols) continue;

                for (const importedName of imp.names) {
                    const targetId = exportedSymbols.get(importedName);
                    if (!targetId) continue;

                    // Check if any intra-file call already references this name
                    // (calls from parser track calledName which may match importedName)
                    let linked = false;
                    const callerIds = callTargetToCallers.get(`${filePath}:${importedName}`);
                    if (callerIds) {
                        for (const callerId of callerIds) {
                            if (callerId !== targetId) {
                                insertEdge(db, callerId, targetId, 'references');
                                totalEdges++;
                                linked = true;
                            }
                        }
                    }

                    // Fallback: if no specific caller found, create one edge from
                    // the first symbol in the file (preserves PageRank connectivity)
                    if (!linked) {
                        const firstId = importingSymbols.values().next().value;
                        if (firstId && firstId !== targetId) {
                            insertEdge(db, firstId, targetId, 'references');
                            totalEdges++;
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
    const lineCount = countLines(content);
    const mtime = getFileMtime(fullPath);
    const fileRecord = getOrCreateFile(db, relPath, hash, language, lineCount, mtime);

    if (!fileRecord.changed) {
        if (shouldClose) db.close();
        return;
    }

    clearFileData(db, fileRecord.id);
    const parsed = parseFile(relPath, content);
    const lookupFileByPath = db.prepare('SELECT id FROM files WHERE path = ?');

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
            parameters: sym.parameters ? JSON.stringify(sym.parameters) : undefined,
        });
        symbolMap.set(sym.name, symId);
        if (sym.qualifiedName) symbolMap.set(sym.qualifiedName, symId);

        // Store type relations
        if (sym.extends) {
            for (const parent of sym.extends) {
                insertTypeRelation(db, symId, parent, 'extends');
            }
        }
        if (sym.implements) {
            for (const iface of sym.implements) {
                insertTypeRelation(db, symId, iface, 'implements');
            }
        }
    }

    // Re-export pseudo-symbols
    for (const reExport of parsed.reExports) {
        for (const name of reExport.names) {
            if (!symbolMap.has(name)) {
                const symId = insertSymbol(db, fileRecord.id, {
                    name,
                    kind: 'reexport',
                    lineStart: 0,
                    lineEnd: 0,
                    signature: `export { ${name} } from '${reExport.source}'`,
                    exported: true,
                });
                symbolMap.set(name, symId);
            }
        }
    }

    // Resolve imports
    for (const imp of parsed.imports) {
        if (isPackageImport(imp.source)) {
            const names = imp.names.length > 0 ? imp.names.join(',') : imp.isDefault ? 'default' : '*';
            insertPkgDep(db, fileRecord.id, imp.source, names);
            continue;
        }

        const resolved = resolveImportPath(rootDir, relPath, imp.source);
        if (resolved) {
            const toFile = lookupFileByPath.get(resolved) as { id: number } | undefined;
            if (toFile) {
                insertFileDep(db, fileRecord.id, toFile.id, 'import', imp.names.join(',') || '*');
            }
        }
    }

    // Intra-file call edges (with line numbers)
    for (const call of parsed.calls) {
        const callerId = symbolMap.get(call.callerSymbol);
        const calledId = symbolMap.get(call.calledName);
        if (callerId && calledId && callerId !== calledId) {
            insertEdge(db, callerId, calledId, 'calls', call.line);
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

    // PageRank iteration — O(n + edges) per iteration, not O(n²)
    let rank = new Float64Array(n).fill(1 / n);
    let newRank = new Float64Array(n);

    for (let iter = 0; iter < iterations; iter++) {
        // Pre-compute dangling mass (nodes with no outgoing edges)
        let danglingMass = 0;
        for (let i = 0; i < n; i++) {
            if (outDegree[i] === 0) danglingMass += rank[i];
        }
        const danglingShare = damping * danglingMass / n;

        // Base: teleport + dangling distribution (uniform)
        newRank.fill((1 - damping) / n + danglingShare);

        // Add rank contributions from edges
        for (let i = 0; i < n; i++) {
            if (outDegree[i] > 0) {
                const share = damping * rank[i] / outDegree[i];
                for (const j of outgoing[i]) {
                    newRank[j] += share;
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
