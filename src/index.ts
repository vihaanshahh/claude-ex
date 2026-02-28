#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import { findProjectRoot, formatMs } from './utils';
import { indexProject, reindexFile } from './indexer';
import {
    searchFromRoot, getCallersFromRoot, getContextFromRoot,
    getImpactFromRoot, getDepsFromRoot, getRankFromRoot,
    getModulesFromRoot, getStatsFromRoot, briefFromRoot,
    preEditContextFromRoot,
} from './query/engine';
import { install } from './claude/installer';
import { writeClaudeMd } from './claude/claudemd';
import { startDaemon, stopDaemon, isDaemonRunning } from './watcher/daemon';
import { runMcpServer } from './claude/mcp';

const program = new Command();

program
    .name('claude-ex')
    .description('Local code intelligence layer for Claude Code')
    .version('1.0.0');

function resolveRoot(pathArg?: string): string {
    if (pathArg) return path.resolve(pathArg);
    const found = findProjectRoot();
    if (found) return found;
    return process.cwd();
}

function requireIndex(pathArg?: string): string {
    const root = resolveRoot(pathArg);
    const found = findProjectRoot(root);
    if (!found) {
        process.stderr.write('Error: No codex index found. Run "claude-ex init" first.\n');
        process.exit(1);
    }
    return found;
}

// --- init ---
program
    .command('init')
    .argument('[path]', 'Project directory')
    .option('-v, --verbose', 'Verbose output')
    .description('Index project + install Claude Code config + generate docs')
    .action((pathArg, opts) => {
        const rootDir = resolveRoot(pathArg);
        const dirname = path.basename(rootDir);

        console.log(`Indexing ${dirname}...`);
        const stats = indexProject(rootDir, { verbose: opts.verbose });

        console.log(`Indexed ${stats.indexedFiles} files (${stats.skippedFiles} unchanged) in ${formatMs(stats.timeMs)}`);
        console.log(`  ${stats.symbols} symbols, ${stats.edges} edges`);

        console.log('Installing Claude Code config...');
        install(rootDir);

        console.log('Generating CLAUDE.md...');
        writeClaudeMd(rootDir);

        console.log('');
        console.log('Setup complete! MCP server will start automatically when you open Claude Code.');
        console.log('Hooks installed: SessionStart, PreToolUse (Write/Edit), PostToolUse (Write/Edit)');
    });

// --- reindex ---
program
    .command('reindex')
    .argument('[path]', 'Project directory')
    .option('-v, --verbose', 'Verbose output')
    .description('Full re-index of the project')
    .action((pathArg, opts) => {
        const rootDir = requireIndex(pathArg);
        const stats = indexProject(rootDir, { verbose: opts.verbose });
        console.log(JSON.stringify(stats));
    });

// --- reindex-file ---
program
    .command('reindex-file')
    .argument('<file>', 'File path relative to project root')
    .description('Re-index a single file')
    .action((file) => {
        const rootDir = requireIndex();
        reindexFile(rootDir, file);
    });

// --- search ---
program
    .command('search')
    .argument('<query>', 'Search query')
    .option('-l, --limit <n>', 'Max results', '15')
    .description('Search for symbols')
    .action((query, opts) => {
        const rootDir = requireIndex();
        const results = searchFromRoot(rootDir, query, parseInt(opts.limit, 10));
        console.log(JSON.stringify(results, null, 2));
    });

// --- callers ---
program
    .command('callers')
    .argument('<symbol>', 'Symbol name')
    .description('Find callers of a symbol')
    .action((symbol) => {
        const rootDir = requireIndex();
        const results = getCallersFromRoot(rootDir, symbol);
        console.log(JSON.stringify(results, null, 2));
    });

// --- context ---
program
    .command('context')
    .argument('<symbol>', 'Symbol name')
    .description('Full context for a symbol')
    .action((symbol) => {
        const rootDir = requireIndex();
        const result = getContextFromRoot(rootDir, symbol);
        console.log(JSON.stringify(result, null, 2));
    });

// --- impact ---
program
    .command('impact')
    .argument('<file>', 'File path')
    .description('Impact analysis for a file')
    .action((file) => {
        const rootDir = requireIndex();
        const results = getImpactFromRoot(rootDir, file);
        console.log(JSON.stringify(results, null, 2));
    });

// --- deps ---
program
    .command('deps')
    .argument('<symbol>', 'Symbol name')
    .description('Dependencies of a symbol')
    .action((symbol) => {
        const rootDir = requireIndex();
        const results = getDepsFromRoot(rootDir, symbol);
        console.log(JSON.stringify(results, null, 2));
    });

// --- rank ---
program
    .command('rank')
    .option('-t, --top <n>', 'Number of top symbols', '20')
    .description('Top symbols by PageRank')
    .action((opts) => {
        const rootDir = requireIndex();
        const results = getRankFromRoot(rootDir, parseInt(opts.top, 10));
        console.log(JSON.stringify(results, null, 2));
    });

// --- modules ---
program
    .command('modules')
    .description('Module dependency map')
    .action(() => {
        const rootDir = requireIndex();
        const results = getModulesFromRoot(rootDir);
        console.log(JSON.stringify(results, null, 2));
    });

// --- stats ---
program
    .command('stats')
    .description('Index statistics')
    .action(() => {
        const rootDir = requireIndex();
        const results = getStatsFromRoot(rootDir);
        console.log(JSON.stringify(results, null, 2));
    });

// --- brief (for SessionStart hook) ---
program
    .command('brief')
    .description('Project summary (plain text, for SessionStart hook)')
    .action(() => {
        const rootDir = requireIndex();
        console.log(briefFromRoot(rootDir));
    });

// --- pre-edit (for PreToolUse hook) ---
program
    .command('pre-edit')
    .argument('<file>', 'File path')
    .description('Pre-edit context (plain text, for PreToolUse hook)')
    .action((file) => {
        const rootDir = requireIndex();
        // Resolve absolute paths to relative
        const relFile = path.isAbsolute(file) ? path.relative(rootDir, file) : file;
        console.log(preEditContextFromRoot(rootDir, relFile));
    });

// --- post-edit (for PostToolUse hook) ---
program
    .command('post-edit')
    .argument('<file>', 'File path')
    .description('Post-edit reindex (silent, for PostToolUse hook)')
    .action((file) => {
        const rootDir = requireIndex();
        const relFile = path.isAbsolute(file) ? path.relative(rootDir, file) : file;
        reindexFile(rootDir, relFile);
    });

// --- generate-docs ---
program
    .command('generate-docs')
    .description('Regenerate CLAUDE.md from the index')
    .action(() => {
        const rootDir = requireIndex();
        writeClaudeMd(rootDir);
        console.log('CLAUDE.md regenerated.');
    });

// --- daemon ---
const daemon = program
    .command('daemon')
    .description('Manage standalone file watcher daemon');

daemon
    .command('start')
    .description('Start standalone file watcher')
    .action(() => {
        const rootDir = requireIndex();
        if (isDaemonRunning(rootDir)) {
            console.log('Daemon is already running.');
            return;
        }
        startDaemon(rootDir);
    });

daemon
    .command('stop')
    .description('Stop standalone file watcher')
    .action(() => {
        const rootDir = requireIndex();
        stopDaemon(rootDir);
    });

daemon
    .command('status')
    .description('Check daemon status')
    .action(() => {
        const rootDir = requireIndex();
        console.log(isDaemonRunning(rootDir) ? 'Daemon is running.' : 'Daemon is not running.');
    });

// --- mcp ---
program
    .command('mcp')
    .description('Run as MCP server (stdio, long-lived)')
    .action(async () => {
        await runMcpServer();
    });

// --- uninstall ---
program
    .command('uninstall')
    .description('Remove all claude-ex config from this project')
    .action(() => {
        const rootDir = resolveRoot();
        const fs = require('fs');

        const toRemove = [
            path.join(rootDir, '.codex'),
            path.join(rootDir, '.claude', 'skills', 'codex'),
        ];

        for (const p of toRemove) {
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true });
                console.log(`Removed: ${path.relative(rootDir, p)}`);
            }
        }

        // Clean .mcp.json
        const mcpPath = path.join(rootDir, '.mcp.json');
        if (fs.existsSync(mcpPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
                if (config.mcpServers?.codex) {
                    delete config.mcpServers.codex;
                    if (Object.keys(config.mcpServers).length === 0) {
                        fs.unlinkSync(mcpPath);
                        console.log('Removed: .mcp.json');
                    } else {
                        fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
                        console.log('Cleaned: .mcp.json');
                    }
                }
            } catch { /* ignore */ }
        }

        // Clean hooks from .claude/settings.json
        const settingsPath = path.join(rootDir, '.claude', 'settings.json');
        if (fs.existsSync(settingsPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
                let changed = false;
                for (const hookType of ['SessionStart', 'PreToolUse', 'PostToolUse']) {
                    if (config.hooks?.[hookType]) {
                        const before = config.hooks[hookType].length;
                        config.hooks[hookType] = config.hooks[hookType].filter(
                            (h: any) => !h.command?.includes('claude-ex')
                        );
                        if (config.hooks[hookType].length !== before) changed = true;
                        if (config.hooks[hookType].length === 0) delete config.hooks[hookType];
                    }
                }
                if (config.hooks && Object.keys(config.hooks).length === 0) delete config.hooks;
                if (changed) {
                    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
                    console.log('Cleaned: .claude/settings.json');
                }
            } catch { /* ignore */ }
        }

        console.log('claude-ex uninstalled.');
    });

// --- daemon-worker (internal, not shown in help) ---
program
    .command('daemon-worker', { hidden: true })
    .argument('<rootDir>')
    .action(async (rootDir) => {
        const { openDatabase } = require('./db/schema');
        const { startWatcher } = require('./watcher/daemon');
        const db = openDatabase(rootDir);
        await startWatcher(rootDir, db);
        // Keep process alive
        process.on('SIGTERM', () => { db.close(); process.exit(0); });
        process.on('SIGINT', () => { db.close(); process.exit(0); });
    });

program.parse();
