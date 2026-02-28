import * as path from 'path';
import * as fs from 'fs';

export function findProjectRoot(startDir?: string): string | null {
    let dir = startDir ? path.resolve(startDir) : process.cwd();
    while (true) {
        if (fs.existsSync(path.join(dir, '.codex', 'index.db'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

export function ensureCodexDir(rootDir: string): string {
    const codexDir = path.join(rootDir, '.codex');
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
