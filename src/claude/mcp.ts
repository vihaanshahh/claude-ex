import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../db/schema';
import { findProjectRoot } from '../utils';
import { startWatcher } from '../watcher/daemon';
import {
    search, getCallers, getContext, getImpact,
    getDeps, getRank, getModules, getStats, findFiles, getFileMap,
    getFileSymbols, findByKind, getTypeHierarchy, findDeadExports, getPkgUsages,
    reviewDiff, transparentReview,
} from '../query/engine';
import { reindexFile } from '../indexer';

export async function runMcpServer(): Promise<void> {
    const rootDir = findProjectRoot() || process.env.CODEX_ROOT || process.cwd();

    const startTime = performance.now();

    // Open database (stays open for lifetime)
    let db: ReturnType<typeof openDatabase>;
    try {
        db = openDatabase(rootDir);
    } catch (err) {
        process.stderr.write(`[codex-mcp] Failed to open database: ${err}\n`);
        process.stderr.write(`[codex-mcp] Run 'claude-ex init' first.\n`);
        process.exit(1);
    }

    // Start file watcher inside MCP server process
    let watcher: any;
    try {
        watcher = await startWatcher(rootDir, db, (file) => {
            process.stderr.write(`[codex-mcp] reindexed: ${file}\n`);
        });
    } catch (err) {
        process.stderr.write(`[codex-mcp] Watcher failed to start: ${err}\n`);
    }

    // Pre-warm statement cache + SQLite page cache
    try { getStats(db); search(db, 'a', 1); } catch { /* warm-up, ignore errors */ }

    const server = new Server(
        { name: 'claude-ex', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );

    // Memoized tool list (allocated once, not per request)
    const TOOL_LIST = [
            {
                name: 'search_code',
                description: 'Search codebase for symbols by name, description, or content. Results ranked by structural importance (PageRank). Faster and more precise than grep for finding the right code.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Search query (natural language or symbol name)' },
                        limit: { type: 'number', description: 'Max results (default 15)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_symbol',
                description: 'Get complete context for a symbol: its code, what it depends on, what depends on it, co-located symbols. Use before modifying any symbol.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Symbol name or qualified name (e.g., processPayment or PaymentService.processPayment)' },
                    },
                    required: ['name'],
                },
            },
            {
                name: 'get_callers',
                description: 'Find all callers of a function or method. Use before renaming, changing signatures, or removing functions.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Function or method name' },
                    },
                    required: ['name'],
                },
            },
            {
                name: 'get_dependents',
                description: 'Find all files transitively affected if a file changes. Use before refactors that change exports or file structure.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        file: { type: 'string', description: 'File path relative to project root' },
                        maxDepth: { type: 'number', description: 'Max traversal depth (default 10)' },
                    },
                    required: ['file'],
                },
            },
            {
                name: 'get_dependencies',
                description: 'Find what a symbol depends on (imports, inherited classes, referenced types).',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Symbol name' },
                    },
                    required: ['name'],
                },
            },
            {
                name: 'get_architecture',
                description: 'Get project architecture overview: top symbols by importance, module dependency map, language breakdown.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        top: { type: 'number', description: 'Number of top symbols to include (default 20)' },
                    },
                },
            },
            {
                name: 'get_file_map',
                description: 'Get a map of every file in the project with its exported symbols. Use to understand where things live without searching. Returns file paths with their key exports.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {},
                },
            },
            {
                name: 'find_files',
                description: 'Find files by path pattern using glob syntax (e.g. "**/*.test.ts", "src/components/*", "*.json"). Faster than shell find/ls commands. Searches indexed files only.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        pattern: { type: 'string', description: 'Glob pattern to match file paths (e.g. "**/*.ts", "src/**/*.test.*", "*.json")' },
                        limit: { type: 'number', description: 'Max results (default 50)' },
                    },
                    required: ['pattern'],
                },
            },
            {
                name: 'get_file_symbols',
                description: 'Get all symbols (functions, classes, variables, etc.) in a specific file. Shows every definition with its kind, line range, signature, and parameters.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        file: { type: 'string', description: 'File path relative to project root' },
                    },
                    required: ['file'],
                },
            },
            {
                name: 'find_by_kind',
                description: 'Find all symbols of a specific kind (class, function, interface, type, enum, method, variable). Ranked by structural importance.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        kind: { type: 'string', description: 'Symbol kind: class, function, interface, type, enum, method, variable, reexport' },
                        limit: { type: 'number', description: 'Max results (default 50)' },
                    },
                    required: ['kind'],
                },
            },
            {
                name: 'get_type_hierarchy',
                description: 'Find all classes that extend or implement a given class/interface. Use before changing a base class or interface to find all affected subclasses/implementors.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Class or interface name to find subclasses/implementors of' },
                    },
                    required: ['name'],
                },
            },
            {
                name: 'find_dead_exports',
                description: 'Find exported symbols that nothing imports or references. Useful for dead code detection and cleanup.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        limit: { type: 'number', description: 'Max results (default 50)' },
                    },
                },
            },
            {
                name: 'get_pkg_usages',
                description: 'Find all files that import from a given npm/pip/cargo package. Use before swapping a library to find every usage point. Example: "react", "lodash", "express".',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        package: { type: 'string', description: 'Package name (e.g., "react", "lodash", "express")' },
                    },
                    required: ['package'],
                },
            },
            {
                name: 'reindex_file',
                description: 'Re-index a single file immediately.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        file: { type: 'string', description: 'File path relative to project root' },
                    },
                    required: ['file'],
                },
            },
            {
                name: 'review_diff',
                description: 'Gather graph-aware review context for a git diff. Parses the diff, maps changed lines to symbols, finds callers/dependents of changed code, computes cross-file impact, and flags risks. Returns structured context for writing a codebase-aware code review.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        target: { type: 'string', description: 'What to review: "last_commit" (default), "staged", "branch" (diff vs main/master), or a commit SHA' },
                    },
                },
            },
            {
                name: 'transparent_review',
                description: 'Zero-black-box code review. Shows EXACT before/after code for every changed symbol, plain-English explanation of what each change does (parameter changes, new branches, error handling, async changes), who calls the changed code and how they are affected, full blast radius grouped by depth, and risk assessment. Returns a readable narrative — not raw JSON. Use this when you want to truly understand a diff, not just see metadata about it.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        target: { type: 'string', description: 'What to review: "last_commit" (default), "staged", "branch" (diff vs main/master), or a commit SHA' },
                    },
                },
            },
    ];

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const callStart = performance.now();

        try {
            let result: any;

            switch (name) {
                case 'search_code':
                    result = search(db, (args as any).query, (args as any).limit);
                    break;
                case 'get_symbol':
                    result = getContext(db, (args as any).name);
                    if (!result) {
                        return { content: [{ type: 'text' as const, text: `Symbol '${(args as any).name}' not found in index.` }] };
                    }
                    break;
                case 'get_callers':
                    result = getCallers(db, (args as any).name);
                    break;
                case 'get_dependents':
                    result = getImpact(db, (args as any).file, (args as any).maxDepth);
                    break;
                case 'get_dependencies':
                    result = getDeps(db, (args as any).name);
                    break;
                case 'get_architecture':
                    result = {
                        stats: getStats(db),
                        topSymbols: getRank(db, (args as any)?.top || 20),
                        modules: getModules(db),
                    };
                    break;
                case 'get_file_map':
                    result = getFileMap(db);
                    break;
                case 'find_files':
                    result = findFiles(db, (args as any).pattern, (args as any).limit);
                    break;
                case 'get_file_symbols':
                    result = getFileSymbols(db, (args as any).file);
                    break;
                case 'find_by_kind':
                    result = findByKind(db, (args as any).kind, (args as any).limit);
                    break;
                case 'get_type_hierarchy':
                    result = getTypeHierarchy(db, (args as any).name);
                    break;
                case 'find_dead_exports':
                    result = findDeadExports(db, (args as any)?.limit);
                    break;
                case 'get_pkg_usages':
                    result = getPkgUsages(db, (args as any).package);
                    break;
                case 'reindex_file': {
                    const fileStart = performance.now();
                    reindexFile(rootDir, (args as any).file, db);
                    result = { success: true, timeMs: +(performance.now() - fileStart).toFixed(1) };
                    break;
                }
                case 'review_diff':
                    result = reviewDiff(db, rootDir, (args as any)?.target || 'last_commit');
                    break;
                case 'transparent_review': {
                    const narrative = transparentReview(db, rootDir, (args as any)?.target || 'last_commit');
                    const elapsed2 = (performance.now() - callStart).toFixed(1);
                    process.stderr.write(`[codex-mcp] transparent_review completed in ${elapsed2}ms\n`);
                    return {
                        content: [{ type: 'text' as const, text: narrative }],
                    };
                }
                default:
                    return {
                        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
                        isError: true,
                    };
            }

            const elapsed = (performance.now() - callStart).toFixed(1);
            process.stderr.write(`[codex-mcp] ${name} completed in ${elapsed}ms\n`);

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(result),
                }],
            };
        } catch (err: any) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
                isError: true,
            };
        }
    });

    const elapsed = (performance.now() - startTime).toFixed(0);
    process.stderr.write(`[codex-mcp] Server started in ${elapsed}ms (root: ${rootDir})\n`);

    // Connect stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Graceful shutdown
    const shutdown = () => {
        process.stderr.write('[codex-mcp] Shutting down...\n');
        if (watcher) watcher.close();
        db.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
