import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import Database from 'better-sqlite3';
import { reindexFile } from '../indexer';
import { isSupportedFile } from '../indexer/parser';

const IGNORE_PATTERNS = [
    '**/node_modules/**', '**/.git/**', '**/.codex/**', '**/dist/**',
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

    const debounceMap = new Map<string, NodeJS.Timeout>();

    function handleChange(fullPath: string) {
        const relPath = path.relative(rootDir, fullPath);
        if (!isSupportedFile(relPath)) return;

        // Debounce 200ms per file
        const existing = debounceMap.get(relPath);
        if (existing) clearTimeout(existing);

        debounceMap.set(relPath, setTimeout(() => {
            debounceMap.delete(relPath);
            try {
                reindexFile(rootDir, relPath, db);
                onReindex?.(relPath);
            } catch (err) {
                process.stderr.write(`[codex] reindex error ${relPath}: ${err}\n`);
            }
        }, 200));
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
    const pidFile = path.join(rootDir, '.codex', 'codex.pid');
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
    const pidFile = path.join(rootDir, '.codex', 'codex.pid');
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
    const pidFile = path.join(rootDir, '.codex', 'codex.pid');
    if (!fs.existsSync(pidFile)) return false;

    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
