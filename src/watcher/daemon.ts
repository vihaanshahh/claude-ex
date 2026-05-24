import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import Database from 'better-sqlite3';
import { reindexFile } from '../indexer';
import { collectFiles } from '../indexer/collector';
import { isSupportedFile } from '../indexer/parser';
import { getCodexDir } from '../utils';

const IGNORE_DIRS = new Set([
    'node_modules', '.git', '.hg', '.svn', '.codex', '.claude', '.local',
    'dist', 'build', 'out', '.next', '.nuxt', '__pycache__', '.pytest_cache',
    'target', 'vendor', 'coverage', '.vscode', '.idea', 'venv', '.venv',
    '.tox', 'bower_components', '.cache', '.parcel-cache', 'tmp', 'temp',
    '.turbo', '.vercel', '.netlify',
]);

function shouldIgnorePath(rootDir: string, fullPath: string): boolean {
    const absPath = path.isAbsolute(fullPath) ? fullPath : path.resolve(rootDir, fullPath);
    const relPath = path.relative(rootDir, absPath);
    if (!relPath || relPath === '') return false;
    return relPath.split(path.sep).some(part => IGNORE_DIRS.has(part));
}

function getWatchTargets(rootDir: string): string[] {
    const targets = new Set<string>();

    for (const relPath of collectFiles(rootDir)) {
        const parts = relPath.split(/[\\/]+/);
        if (parts.length <= 1) {
            targets.add(path.join(rootDir, relPath));
        } else {
            targets.add(path.join(rootDir, parts[0]));
        }
    }

    return [...targets];
}

export async function startWatcher(
    rootDir: string,
    db: Database.Database,
    onReindex?: (file: string) => void
): Promise<any> {
    const chokidar = await import('chokidar');

    const watchTargets = getWatchTargets(rootDir);
    if (watchTargets.length === 0) {
        return { close: () => Promise.resolve() };
    }

    const watcher = chokidar.watch(watchTargets, {
        ignored: (fullPath: string) => shouldIgnorePath(rootDir, fullPath),
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    // Batch debounce: collect changed files, reindex in one burst
    const pendingFiles = new Set<string>();
    let batchTimeout: NodeJS.Timeout | null = null;
    let flushing = false;
    const BATCH_DELAY = 300; // ms — wait for burst of saves to settle

    function scheduleFlush() {
        if (batchTimeout) clearTimeout(batchTimeout);
        batchTimeout = setTimeout(flushBatch, BATCH_DELAY);
    }

    function flushBatch() {
        batchTimeout = null;
        if (flushing) {
            scheduleFlush();
            return;
        }
        flushing = true;
        const files = [...pendingFiles];
        pendingFiles.clear();
        try {
            for (const relPath of files) {
                try {
                    reindexFile(rootDir, relPath, db);
                    onReindex?.(relPath);
                } catch (err) {
                    process.stderr.write(`[codex] reindex error ${relPath}: ${err}\n`);
                }
            }
        } finally {
            flushing = false;
            if (pendingFiles.size > 0) scheduleFlush();
        }
    }

    function handleChange(fullPath: string) {
        const relPath = path.relative(rootDir, fullPath);
        if (!isSupportedFile(relPath)) return;

        pendingFiles.add(relPath);
        scheduleFlush();
    }

    function handleDelete(fullPath: string) {
        const relPath = path.relative(rootDir, fullPath);
        try {
            reindexFile(rootDir, relPath, db);
        } catch {
            // ignore
        }
    }

    watcher.on('change', handleChange);
    watcher.on('add', handleChange);
    watcher.on('unlink', handleDelete);
    let closedAfterError = false;
    watcher.on('error', (err: any) => {
        const suffix = err?.path ? ` (${err.path})` : '';
        process.stderr.write(`[codex] watcher error: ${err}${suffix}\n`);
        if (!closedAfterError && (err?.code === 'EMFILE' || err?.code === 'ENOSPC')) {
            closedAfterError = true;
            watcher.close().catch(() => { /* ignore close errors */ });
        }
    });

    return watcher;
}

export function startDaemon(rootDir: string): void {
    const pidFile = path.join(getCodexDir(rootDir), 'codex.pid');
    const script = path.resolve(__dirname, '..', 'index.js');

    const child = child_process.spawn(process.execPath, [script, 'daemon-worker', rootDir], {
        detached: true,
        stdio: 'ignore',
    });

    child.unref();

    if (child.pid) {
        fs.writeFileSync(pidFile, String(child.pid));
        console.log(`Daemon started (PID: ${child.pid})`);
    }
}

export function stopDaemon(rootDir: string): void {
    const pidFile = path.join(getCodexDir(rootDir), 'codex.pid');
    if (!fs.existsSync(pidFile)) {
        console.log('No daemon running.');
        return;
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    try {
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(pidFile);
        console.log(`Daemon stopped (PID: ${pid})`);
    } catch {
        fs.unlinkSync(pidFile);
        console.log('Daemon was not running. Cleaned up PID file.');
    }
}

export function isDaemonRunning(rootDir: string): boolean {
    const pidFile = path.join(getCodexDir(rootDir), 'codex.pid');
    if (!fs.existsSync(pidFile)) return false;

    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
