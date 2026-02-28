import * as fs from 'fs';
import * as path from 'path';

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
    '.next', '.nuxt', '__pycache__', '.pytest_cache', 'target', 'vendor',
    '.codex', '.claude', 'coverage', '.vscode', '.idea', 'venv', '.venv',
    '.env', '.tox', 'bower_components', '.cache', '.parcel-cache',
    'tmp', 'temp', '.turbo', '.vercel', '.netlify',
]);

const SKIP_EXTENSIONS = new Set([
    '.lock', '.log', '.map', '.min.js', '.min.css',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm', '.ogg',
    '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.exe', '.dll', '.so', '.dylib', '.o', '.a',
    '.pyc', '.pyo', '.class', '.jar',
    '.db', '.sqlite', '.sqlite3',
    '.bin', '.dat', '.img', '.iso',
]);

const SUPPORTED_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs',
    '.py',
    '.rs',
    '.go',
    '.sh', '.bash',
    '.c', '.h',
    '.cpp', '.cc', '.hpp',
    '.json',
    '.css',
    '.html', '.htm',
]);

const MAX_FILE_SIZE = 512 * 1024; // 512KB

function parseGitignore(rootDir: string): Set<string> {
    const ignored = new Set<string>();
    const gitignorePath = path.join(rootDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return ignored;

    try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const name = trimmed.replace(/\/$/, '').replace(/^\//, '');
            if (!name.includes('/') && !name.includes('*')) {
                ignored.add(name);
            }
        }
    } catch {
        // ignore read errors
    }
    return ignored;
}

export function collectFiles(rootDir: string): string[] {
    const files: string[] = [];
    const gitignored = parseGitignore(rootDir);

    function walk(dir: string) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const name = entry.name;

            if (entry.isDirectory()) {
                if (name.startsWith('.') || SKIP_DIRS.has(name) || gitignored.has(name)) continue;
                walk(path.join(dir, name));
            } else if (entry.isFile()) {
                const ext = path.extname(name).toLowerCase();
                if (SKIP_EXTENSIONS.has(ext)) continue;
                if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

                const fullPath = path.join(dir, name);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > MAX_FILE_SIZE) continue;
                } catch {
                    continue;
                }

                files.push(path.relative(rootDir, fullPath));
            }
        }
    }

    walk(rootDir);
    return files;
}
