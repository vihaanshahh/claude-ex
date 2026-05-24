import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { install } from '../src/claude/installer';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-installer-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('install with codex option', () => {
    it('creates AGENTS.md and registers Codex MCP when missing', () => {
        const commandRunner = vi
            .fn()
            .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' })
            .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

        install(tmpDir, { codex: true, commandRunner });

        const agentsPath = path.join(tmpDir, 'AGENTS.md');
        expect(fs.existsSync(agentsPath)).toBe(true);
        const content = fs.readFileSync(agentsPath, 'utf-8');
        expect(content).toContain('<!-- claude-ex:agents:start -->');
        expect(content).toContain('Use the `claude-ex` MCP server');
        expect(commandRunner).toHaveBeenNthCalledWith(1, 'codex', ['mcp', 'get', 'claude-ex'], {
            cwd: tmpDir,
            encoding: 'utf-8',
        });
        expect(commandRunner).toHaveBeenNthCalledWith(2, 'codex', ['mcp', 'add', 'claude-ex', '--', 'claude-ex', 'mcp', '--no-watch', tmpDir], {
            cwd: tmpDir,
            encoding: 'utf-8',
        });
    });

    it('preserves user AGENTS.md content and skips add when already registered', () => {
        const agentsPath = path.join(tmpDir, 'AGENTS.md');
        fs.writeFileSync(agentsPath, '# Team Notes\n\nKeep this.\n');

        const commandRunner = vi.fn().mockReturnValue({ status: 0, stdout: tmpDir, stderr: '' });

        install(tmpDir, { codex: true, commandRunner });

        const content = fs.readFileSync(agentsPath, 'utf-8');
        expect(content).toContain('# Team Notes');
        expect(content).toContain('Keep this.');
        expect(content).toContain('<!-- claude-ex:agents:start -->');
        expect(commandRunner).toHaveBeenCalledTimes(1);
    });

    it('gitignores AGENTS.md in work mode', () => {
        const commandRunner = vi
            .fn()
            .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' })
            .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

        install(tmpDir, { codex: true, work: true, commandRunner });

        const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        expect(gitignore).toContain('AGENTS.md');
    });

    it('updates an existing Codex MCP registration when it points at another root', () => {
        const commandRunner = vi
            .fn()
            .mockReturnValueOnce({ status: 0, stdout: 'claude-ex mcp /old/root', stderr: '' })
            .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
            .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

        install(tmpDir, { codex: true, commandRunner });

        expect(commandRunner).toHaveBeenNthCalledWith(2, 'codex', ['mcp', 'remove', 'claude-ex'], {
            cwd: tmpDir,
            encoding: 'utf-8',
        });
        expect(commandRunner).toHaveBeenNthCalledWith(3, 'codex', ['mcp', 'add', 'claude-ex', '--', 'claude-ex', 'mcp', '--no-watch', tmpDir], {
            cwd: tmpDir,
            encoding: 'utf-8',
        });
    });
});
