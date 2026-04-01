import * as path from 'path';
import * as fs from 'fs';

export function findProjectRoot(startDir?: string): string | null {
    let dir = startDir ? path.resolve(startDir) : process.cwd();
    while (true) {
        // Check .local/.codex/ first (work mode), then .codex/
        if (fs.existsSync(path.join(dir, '.local', '.codex', 'index.db'))) {
            return dir;
        }
        if (fs.existsSync(path.join(dir, '.codex', 'index.db'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/** Returns the .codex directory path, preferring .local/.codex if it exists */
export function getCodexDir(rootDir: string): string {
    const localDir = path.join(rootDir, '.local', '.codex');
    if (fs.existsSync(localDir)) return localDir;
    return path.join(rootDir, '.codex');
}

export function ensureCodexDir(rootDir: string, work?: boolean): string {
    const codexDir = work
        ? path.join(rootDir, '.local', '.codex')
        : getCodexDir(rootDir); // Use existing location if already set up
    if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true });
    }
    return codexDir;
}

export function relativePath(rootDir: string, filePath: string): string {
    return path.relative(rootDir, path.resolve(rootDir, filePath));
}

export function formatMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

export function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + '...';
}

export function countLines(content: string): number {
    let count = 1;
    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) count++;
    }
    return count;
}
