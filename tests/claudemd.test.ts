import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateClaudeMd, writeClaudeMd } from '../src/claude/claudemd';
import { openDatabase } from '../src/db/schema';
import { indexProject } from '../src/indexer';

let tmpDir: string;

function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claudemd-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateClaudeMd', () => {
    it('produces valid markdown with markers', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        const md = generateClaudeMd(tmpDir);
        expect(md).toContain('<!-- claude-ex:start -->');
        expect(md).toContain('<!-- claude-ex:end -->');
    });

    it('includes project name from directory', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        const md = generateClaudeMd(tmpDir);
        const dirname = path.basename(tmpDir);
        expect(md).toContain(`# Project: ${dirname}`);
    });

    it('includes architecture section', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        const md = generateClaudeMd(tmpDir);
        expect(md).toContain('## Architecture');
        expect(md).toContain('typescript');
    });

    it('includes MCP tools section', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        const md = generateClaudeMd(tmpDir);
        expect(md).toContain('## Codex MCP Tools');
        expect(md).toContain('search_code');
        expect(md).toContain('get_callers');
    });

    it('includes development cycle', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        const md = generateClaudeMd(tmpDir);
        expect(md).toContain('## Development Cycle');
        expect(md).toContain('Understand');
        expect(md).toContain('Plan');
        expect(md).toContain('Implement');
        expect(md).toContain('Verify');
        expect(md).toContain('Review');
    });

    it('includes decision guide table', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        const md = generateClaudeMd(tmpDir);
        expect(md).toContain('| You want to...');
        expect(md).toContain('Grep/ripgrep');
    });
});

describe('writeClaudeMd', () => {
    it('creates CLAUDE.md when it does not exist', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        writeClaudeMd(tmpDir);
        const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
        expect(fs.existsSync(claudeMdPath)).toBe(true);
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        expect(content).toContain('<!-- claude-ex:start -->');
        expect(content).toContain('<!-- claude-ex:end -->');
    });

    it('preserves user content before markers', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);

        // Write user content first
        const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
        fs.writeFileSync(claudeMdPath, '# My Custom Notes\n\nDo not touch this.\n');

        // Now run writeClaudeMd — should append
        writeClaudeMd(tmpDir);
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        expect(content).toContain('# My Custom Notes');
        expect(content).toContain('Do not touch this.');
        expect(content).toContain('<!-- claude-ex:start -->');
    });

    it('preserves user content after markers', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);

        const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
        const generated = generateClaudeMd(tmpDir);
        fs.writeFileSync(claudeMdPath,
            'User top content\n\n' + generated + '\n\n# User bottom content\n'
        );

        writeClaudeMd(tmpDir);
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        expect(content).toContain('User top content');
        expect(content).toContain('# User bottom content');
    });

    it('does not write when content is unchanged', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        writeClaudeMd(tmpDir);

        const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
        const mtime1 = fs.statSync(claudeMdPath).mtimeMs;

        // Small delay to ensure mtime would differ if written
        const before = Date.now();
        while (Date.now() - before < 50) { /* spin */ }

        writeClaudeMd(tmpDir);
        const mtime2 = fs.statSync(claudeMdPath).mtimeMs;
        expect(mtime2).toBe(mtime1); // File was not rewritten
    });

    it('replaces only the generated section on update', () => {
        writeFile('src/a.ts', 'export function hello() {}');
        indexProject(tmpDir);
        writeClaudeMd(tmpDir);

        // Add a second file and re-index
        writeFile('src/b.ts', 'export function world() {}');
        indexProject(tmpDir);
        writeClaudeMd(tmpDir);

        const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
        // Should have exactly one pair of markers
        const startCount = (content.match(/<!-- claude-ex:start -->/g) || []).length;
        const endCount = (content.match(/<!-- claude-ex:end -->/g) || []).length;
        expect(startCount).toBe(1);
        expect(endCount).toBe(1);
    });
});
