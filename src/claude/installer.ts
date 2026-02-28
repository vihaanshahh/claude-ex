import * as fs from 'fs';
import * as path from 'path';

const SKILL_CONTENT = `---
name: claude-ex
description: >
  Local codebase intelligence via MCP. Use for: finding code, understanding
  architecture, tracing dependencies, impact analysis, finding callers,
  understanding what a file/function does in context. Triggers: "what calls",
  "who uses", "what depends on", "where is", "how does X work", "what breaks if",
  "find", "search codebase", "show me", refactoring, architecture questions.
  PREFER these MCP tools over grep/ripgrep for structural queries.
---

# claude-ex — Codebase Intelligence (MCP)

This project has a live code index exposed via MCP. The MCP tools are
**much faster and more precise than grep** for structural questions.

## MCP Tools Available

Use these tools via the MCP connection. They answer in <5ms.

### search_code
Find symbols by name, description, or content. Results ranked by structural
importance (PageRank). Use for any "find X" or "where is X" question.

### get_symbol
Full context for a single symbol: its code, what it depends on, what depends
on it, what else is in the same file. Use before modifying any symbol.

### get_callers
Who calls this function/method. Use before renaming, changing signatures,
or removing a function.

### get_dependents
What files are transitively affected if a file changes. Use before any
refactor that changes exports or file structure.

### get_dependencies
What a symbol imports/uses. Understand what it needs before moving or
modifying it.

### get_architecture
Project overview: top symbols, module map, language breakdown.
Use when you need to understand the overall structure.

## When to prefer MCP tools over grep
- "What calls processPayment?" → get_callers (not grep — grep misses indirect references)
- "What breaks if I change auth.ts?" → get_dependents (not grep — grep can't trace transitive deps)
- "Find the main payment handling code" → search_code (PageRank-weighted, finds the important one)
- "Show me the PaymentService" → get_symbol (includes dependencies + dependents, not just code)

## When to use grep instead
- Simple string search: "find all TODOs" → grep
- Regex patterns: "find all console.log" → grep
- File listing: "show all test files" → find
`;

export function install(rootDir: string): void {
    // 1. Ensure .codex/ exists and is in .gitignore
    const codexDir = path.join(rootDir, '.codex');
    if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true });
    }
    addToGitignore(rootDir, '.codex/');

    // 2. Create/merge .mcp.json
    installMcpConfig(rootDir);

    // 3. Create/merge .claude/settings.json
    installHooks(rootDir);

    // 4. Create skill file
    installSkill(rootDir);
}

function addToGitignore(rootDir: string, entry: string): void {
    const gitignorePath = path.join(rootDir, '.gitignore');
    let content = '';
    if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf-8');
    }
    if (!content.split('\n').some(line => line.trim() === entry)) {
        content = content.trimEnd() + '\n' + entry + '\n';
        fs.writeFileSync(gitignorePath, content);
    }
}

function installMcpConfig(rootDir: string): void {
    const mcpPath = path.join(rootDir, '.mcp.json');
    let config: any = {};

    if (fs.existsSync(mcpPath)) {
        try {
            config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
        } catch {
            config = {};
        }
    }

    if (!config.mcpServers) config.mcpServers = {};

    config.mcpServers.codex = {
        type: 'stdio',
        command: 'claude-ex',
        args: ['mcp'],
    };

    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
}

function installHooks(rootDir: string): void {
    const claudeDir = path.join(rootDir, '.claude');
    if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
    }

    const settingsPath = path.join(claudeDir, 'settings.json');
    let config: any = {};

    if (fs.existsSync(settingsPath)) {
        try {
            config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        } catch {
            config = {};
        }
    }

    if (!config.hooks) config.hooks = {};

    // Helper to check if any hook entry already has a claude-ex command
    const hasClaudeEx = (entries: any[]) =>
        entries.some((e: any) => e.hooks?.some((h: any) => h.command?.includes('claude-ex')));

    // SessionStart
    if (!config.hooks.SessionStart) config.hooks.SessionStart = [];
    if (!hasClaudeEx(config.hooks.SessionStart)) {
        config.hooks.SessionStart.push({
            matcher: "",
            hooks: [{
                type: 'command',
                command: 'claude-ex brief',
                timeout: 5000,
            }],
        });
    }

    // PreToolUse (Write, Edit, MultiEdit)
    if (!config.hooks.PreToolUse) config.hooks.PreToolUse = [];
    if (!hasClaudeEx(config.hooks.PreToolUse)) {
        for (const tool of ['Write', 'Edit', 'MultiEdit']) {
            config.hooks.PreToolUse.push({
                matcher: tool,
                hooks: [{
                    type: 'command',
                    command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"',
                    timeout: 3000,
                }],
            });
        }
    }

    // PostToolUse (Write, Edit, MultiEdit)
    if (!config.hooks.PostToolUse) config.hooks.PostToolUse = [];
    if (!hasClaudeEx(config.hooks.PostToolUse)) {
        for (const tool of ['Write', 'Edit', 'MultiEdit']) {
            config.hooks.PostToolUse.push({
                matcher: tool,
                hooks: [{
                    type: 'command',
                    command: 'claude-ex post-edit "$(jq -r \'.tool_input.file_path\')"',
                    timeout: 5000,
                }],
            });
        }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
}

function installSkill(rootDir: string): void {
    const skillDir = path.join(rootDir, '.claude', 'skills', 'codex');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_CONTENT);
}
