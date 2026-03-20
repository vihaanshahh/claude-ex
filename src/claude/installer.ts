import * as fs from 'fs';
import * as path from 'path';

const SKILL_CONTENT = `---
name: claude-ex
description: >
  Local codebase intelligence via MCP. Use for: finding code, understanding
  architecture, tracing dependencies, impact analysis, finding callers,
  understanding what a file/function does in context. Triggers: "what calls",
  "who uses", "what depends on", "where is", "how does X work", "what breaks if",
  "find", "search codebase", "show me", "all classes", "all interfaces",
  "dead code", "what imports lodash", "type hierarchy", refactoring, architecture.
  PREFER these MCP tools over grep/ripgrep for structural queries.
  Also use find_files for finding files by name pattern instead of shell find/ls.
---

# claude-ex — Codebase Intelligence (MCP)

This project has a live code index exposed via MCP. The MCP tools are
**much faster and more precise than grep** for structural questions.

## MCP Tools Available

Use these tools via the MCP connection. They answer in <5ms.

### search_code
Find symbols by name, description, or content. Results ranked by structural
importance (PageRank). Use for any "find X" or "where is X" question.

### find_files
Find files by path pattern using glob syntax (e.g. "**/*.test.ts",
"src/components/*", "*.json"). Much faster than shell find or ls commands.

### get_symbol
Full context for a single symbol: its code, what it depends on, what depends
on it, what else is in the same file. Use before modifying any symbol.

### get_file_map
Get a complete map of every file and its exports. Use when you need to
understand the full project layout, or to find where something is defined
without searching. This is the project's "memory".

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

### get_file_symbols
All symbols (functions, classes, variables, etc.) in a specific file.
Shows every definition with kind, line range, signature, and parameters.

### find_by_kind
Find all symbols of a specific kind (class, function, interface, type,
enum, method, variable). Results ranked by structural importance.

### get_type_hierarchy
Who extends or implements a class/interface. Use before changing a base
class or interface to find all affected subclasses and implementors.

### find_dead_exports
Exported symbols that nothing imports or references. Useful for dead
code detection and cleanup.

### get_pkg_usages
Find all files that import from a given npm/pip/cargo package. Use
before swapping a library to find every usage point.

### reindex_file
Re-index a single file immediately after making major changes.

### review_diff
Gather graph-aware context for reviewing a git diff. Analyzes changed symbols,
their callers and dependents, cross-file impact, and risk assessment. Use when
reviewing commits, staged changes, or branch diffs. Returns structured context
so you can write an informed code review. Targets: "last_commit", "staged",
"branch", or a commit SHA.

## When to prefer MCP tools over grep
- "What calls processPayment?" → get_callers (not grep — grep misses indirect references)
- "What breaks if I change auth.ts?" → get_dependents (not grep — grep can't trace transitive deps)
- "Find the main payment handling code" → search_code (PageRank-weighted, finds the important one)
- "Show me the PaymentService" → get_symbol (includes dependencies + dependents, not just code)
- "Find all test files" → find_files with "**/*.test.*" (faster than shell find)
- "List all JSON configs" → find_files with "*.json"
- "Where does X happen?" → get_file_map to see the whole project layout at a glance
- "I need to understand this project" → get_file_map + get_architecture
- "What's in auth.ts?" → get_file_symbols (every definition with signatures)
- "Show all interfaces" → find_by_kind with "interface"
- "What extends BaseService?" → get_type_hierarchy
- "Any dead exports?" → find_dead_exports
- "What uses lodash?" → get_pkg_usages with "lodash"
- "Review this commit" → review_diff with "last_commit"
- "Review my staged changes" → review_diff with "staged"
- "Review this branch/PR" → review_diff with "branch"

## When to use grep instead
- Simple string search: "find all TODOs" → grep
- Regex patterns: "find all console.log" → grep
`;

const REVIEW_SKILL_CONTENT = `---
name: review
description: >
  Codebase-aware code review using the code graph. Reviews the last commit,
  staged changes, or branch diff with full dependency and impact analysis.
  Triggers: "review", "/review", "code review", "review this PR", "review changes"
argument-hint: "[last_commit|staged|branch|<sha>]"
allowed-tools: mcp__codex__review_diff, mcp__codex__get_symbol, mcp__codex__get_callers, mcp__codex__search_code
---

# Code Review

Review the changes using the \`review_diff\` MCP tool with target "$ARGUMENTS" (default: "last_commit" if no argument provided).

## Steps

1. Call \`review_diff\` with the target to get graph-aware context (changed symbols, callers, impact, risks)
2. Analyze the structured result carefully
3. For any high-risk or complex changes, use \`get_symbol\` to read the full code of affected symbols
4. Write a comprehensive review following the format below

## Review Format

### Summary
- One-paragraph overview of what changed and why
- Files changed, symbols modified, blast radius

### Risk Assessment
- Flag high-importance symbols that were modified (check pagerank)
- Note exported symbols with many callers that could cascade
- Warn about deleted files with dependents (broken imports)
- Highlight large transitive impact

### File-by-File Review
For each changed file with symbols:
- What symbols changed and their role in the codebase
- Potential issues: bugs, logic errors, missing edge cases, type safety
- Whether callers/dependents in other files need updating
- Code quality: naming, patterns, consistency with codebase conventions

### Cross-File Concerns
- Dependencies that may break from these changes
- Pattern inconsistencies across the codebase
- Missing updates in dependent files listed in affectedDependents

### Verdict
- Overall assessment: approve, request changes, or needs discussion
- Prioritized list of action items if any
`;

export function install(rootDir: string, options?: { work?: boolean }): void {
    const work = options?.work ?? false;

    if (work) {
        // Work mode: data goes in .local/.codex/, config stays at root but is gitignored
        const codexDir = path.join(rootDir, '.local', '.codex');
        if (!fs.existsSync(codexDir)) {
            fs.mkdirSync(codexDir, { recursive: true });
        }
        addToGitignore(rootDir, '.local/');
        addToGitignore(rootDir, '.claude/');
        addToGitignore(rootDir, '.mcp.json');
    } else {
        // Normal mode: .codex/ at root
        const codexDir = path.join(rootDir, '.codex');
        if (!fs.existsSync(codexDir)) {
            fs.mkdirSync(codexDir, { recursive: true });
        }
        addToGitignore(rootDir, '.codex/');
    }

    // 2. Create/merge .mcp.json
    installMcpConfig(rootDir);

    // 3. Create/merge .claude/settings.json
    installHooks(rootDir);

    // 4. Create skill files
    installSkill(rootDir);
    installReviewSkill(rootDir);
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

    // Auto-allow codex MCP tools so users don't get prompted
    if (!config.permissions) config.permissions = {};
    if (!config.permissions.allow) config.permissions.allow = [];
    const mcpPattern = 'mcp__codex__*';
    if (!config.permissions.allow.includes(mcpPattern)) {
        config.permissions.allow.push(mcpPattern);
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

    // PreToolUse (Write, Edit, MultiEdit, Read)
    if (!config.hooks.PreToolUse) config.hooks.PreToolUse = [];
    if (!hasClaudeEx(config.hooks.PreToolUse)) {
        for (const tool of ['Write', 'Edit', 'MultiEdit', 'Read']) {
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

function installReviewSkill(rootDir: string): void {
    const skillDir = path.join(rootDir, '.claude', 'skills', 'review');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), REVIEW_SKILL_CONTENT);
}
