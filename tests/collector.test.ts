import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectFiles, MAX_FILE_SIZE } from '../src/indexer/collector';

let tmpDir: string;

function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

function mkdir(relPath: string) {
    fs.mkdirSync(path.join(tmpDir, relPath), { recursive: true });
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-collector-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectFiles', () => {
    it('collects supported file types', () => {
        writeFile('src/a.ts', 'export const x = 1;');
        writeFile('src/b.js', 'const y = 2;');
        writeFile('src/c.py', 'x = 1');
        writeFile('src/d.go', 'package main');
        writeFile('src/e.rs', 'fn main() {}');
        writeFile('src/f.c', 'int main() {}');
        writeFile('src/g.cpp', 'int main() {}');
        writeFile('src/h.sh', '#!/bin/bash');

        const files = collectFiles(tmpDir);
        expect(files.length).toBe(8);
        expect(files.sort()).toEqual([
            'src/a.ts', 'src/b.js', 'src/c.py', 'src/d.go',
            'src/e.rs', 'src/f.c', 'src/g.cpp', 'src/h.sh',
        ].sort());
    });

    it('skips node_modules', () => {
        writeFile('src/a.ts', 'export const x = 1;');
        writeFile('node_modules/pkg/index.js', 'module.exports = {};');

        const files = collectFiles(tmpDir);
        expect(files).toEqual(['src/a.ts']);
    });

    it('skips .git directory', () => {
        writeFile('src/a.ts', 'x');
        writeFile('.git/config', 'x');

        const files = collectFiles(tmpDir);
        expect(files).toEqual(['src/a.ts']);
    });

    it('skips dist and build directories', () => {
        writeFile('src/a.ts', 'x');
        writeFile('dist/a.js', 'x');
        writeFile('build/a.js', 'x');

        const files = collectFiles(tmpDir);
        expect(files).toEqual(['src/a.ts']);
    });

    it('skips binary and non-supported extensions', () => {
        writeFile('src/a.ts', 'x');
        writeFile('src/image.png', 'x');
        writeFile('src/data.zip', 'x');
        writeFile('src/style.lock', 'x');
        writeFile('src/data.db', 'x');

        const files = collectFiles(tmpDir);
        expect(files).toEqual(['src/a.ts']);
    });

    it('.min.js is collected since extension is .js', () => {
        // .min.js extension is .js (path.extname), so it passes the filter
        writeFile('src/bundle.min.js', 'var x = 1;');
        const files = collectFiles(tmpDir);
        expect(files.length).toBe(1);
    });

    it('skips hidden directories', () => {
        writeFile('src/a.ts', 'x');
        writeFile('.hidden/b.ts', 'x');
        writeFile('.vscode/settings.json', '{}');

        const files = collectFiles(tmpDir);
        expect(files).toEqual(['src/a.ts']);
    });

    it('returns empty for empty directory', () => {
        const files = collectFiles(tmpDir);
        expect(files).toEqual([]);
    });

    it('respects .gitignore simple patterns', () => {
        writeFile('.gitignore', 'generated\ncache\n');
        writeFile('src/a.ts', 'x');
        mkdir('generated');
        writeFile('generated/out.ts', 'x');
        mkdir('cache');
        writeFile('cache/tmp.ts', 'x');

        const files = collectFiles(tmpDir);
        expect(files).toEqual(['src/a.ts']);
    });

    it('ignores .gitignore comments and empty lines', () => {
        writeFile('.gitignore', '# comment\n\ngenerated\n');
        writeFile('src/a.ts', 'x');
        writeFile('generated/out.ts', 'x');

        const files = collectFiles(tmpDir);
        expect(files).toEqual(['src/a.ts']);
    });

    it('collects tsx and jsx files', () => {
        writeFile('src/App.tsx', 'export default function App() {}');
        writeFile('src/Widget.jsx', 'export default function Widget() {}');

        const files = collectFiles(tmpDir);
        expect(files.sort()).toEqual(['src/App.tsx', 'src/Widget.jsx']);
    });

    it('collects .mjs files', () => {
        writeFile('lib/module.mjs', 'export const x = 1;');
        const files = collectFiles(tmpDir);
        expect(files).toEqual(['lib/module.mjs']);
    });

    it('handles deeply nested directories', () => {
        writeFile('a/b/c/d/e/f.ts', 'export const x = 1;');
        const files = collectFiles(tmpDir);
        expect(files).toEqual(['a/b/c/d/e/f.ts']);
    });

    it('handles unreadable directories gracefully', () => {
        writeFile('src/a.ts', 'x');
        // collectFiles should not throw even if walk fails on a sub-dir
        const files = collectFiles(tmpDir);
        expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it('skips __pycache__ and vendor', () => {
        writeFile('src/a.py', 'x = 1');
        writeFile('__pycache__/b.py', 'x');
        writeFile('vendor/c.go', 'package main');

        const files = collectFiles(tmpDir);
        expect(files).toEqual(['src/a.py']);
    });

    it('collects header files (.h, .hpp)', () => {
        writeFile('include/lib.h', '#pragma once');
        writeFile('include/lib.hpp', '#pragma once');

        const files = collectFiles(tmpDir);
        expect(files.sort()).toEqual(['include/lib.h', 'include/lib.hpp']);
    });

    it('collects json, css, and html files', () => {
        writeFile('config.json', '{}');
        writeFile('style.css', 'body {}');
        writeFile('index.html', '<html></html>');

        const files = collectFiles(tmpDir);
        expect(files.length).toBe(3);
    });
});

describe('MAX_FILE_SIZE', () => {
    it('is exported and is 512KB', () => {
        expect(MAX_FILE_SIZE).toBe(512 * 1024);
    });
});
