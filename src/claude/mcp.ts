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
    getDeps, getRank, getModules, getStats,
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

    const server = new Server(
        { name: 'claude-ex', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );

    // Register tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
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
        ],
    }));

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
                case 'reindex_file': {
                    const fileStart = performance.now();
                    reindexFile(rootDir, (args as any).file, db);
                    result = { success: true, timeMs: +(performance.now() - fileStart).toFixed(1) };
                    break;
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
                    text: JSON.stringify(result, null, 2),
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
