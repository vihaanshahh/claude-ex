import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import Database from 'better-sqlite3';
import { reindexFile } from '../indexer';
import { isSupportedFile } from '../indexer/parser';
import { getCodexDir } from '../utils';

const IGNORE_PATTERNS = [
    '**/node_modules/**', '**/.git/**', '**/.codex/**', '**/.local/**', '**/dist/**',
    '**/build/**', '**/out/**', '**/.next/**', '**/.nuxt/**',
    '**/__pycache__/**', '**/target/**', '**/vendor/**', '**/coverage/**',
    '**/.cache/**', '**/tmp/**', '**/temp/**',
];

export async function startWatcher(
    rootDir: string,
    db: Database.Database,
    onReindex?: (file: string) => void
): Promise<any> {
    const chokidar = await import('chokidar');

    const watcher = chokidar.watch(rootDir, {
        ignored: IGNORE_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    // Batch debounce: collect changed files, reindex in one burst
    const pendingFiles = new Set<string>();
    let batchTimeout: NodeJS.Timeout | null = null;
    const BATCH_DELAY = 300; // ms — wait for burst of saves to settle

    function flushBatch() {
        batchTimeout = null;
        const files = [...pendingFiles];
        pendingFiles.clear();
        for (const relPath of files) {
            try {
                reindexFile(rootDir, relPath, db);
                onReindex?.(relPath);
            } catch (err) {
                process.stderr.write(`[codex] reindex error ${relPath}: ${err}\n`);
            }
        }
    }

    function handleChange(fullPath: string) {
        const relPath = path.relative(rootDir, fullPath);
        if (!isSupportedFile(relPath)) return;

        pendingFiles.add(relPath);
        if (batchTimeout) clearTimeout(batchTimeout);
        batchTimeout = setTimeout(flushBatch, BATCH_DELAY);
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
