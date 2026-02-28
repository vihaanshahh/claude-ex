# codex-engine

Local code intelligence layer for Claude Code. Indexes your codebase into a SQLite graph database (symbols + dependency edges + PageRank), then runs as a persistent MCP server that Claude Code queries in real-time.

Zero cloud. Zero API keys. Zero extra cost. Just your existing Claude Code subscription, supercharged.

## Quick Start

```bash
npm install
npm run build
npm link

cd /path/to/your/project
codex-engine init
```

Then open Claude Code — the MCP server starts automatically and gives Claude structural awareness of your entire codebase.

## How It Works

1. **Indexes** your codebase using tree-sitter (functions, classes, methods, imports, call graphs)
2. **Computes PageRank** to identify structurally important symbols
3. **Runs as MCP server** with the SQLite database held open in memory — every query answers in <5ms
4. **Watches files** for changes and reindexes in <15ms
5. **Hooks into Claude Code** to inject context before/after edits

## MCP Tools

| Tool | What it does | Speed |
|------|-------------|-------|
| `search_code` | Hybrid FTS5 + PageRank search | 1-3ms |
| `get_symbol` | Full context for a symbol | 2-4ms |
| `get_callers` | Who calls this function | 1-3ms |
| `get_dependents` | What breaks if a file changes | 2-5ms |
| `get_dependencies` | What a symbol depends on | 1-3ms |
| `get_architecture` | Project overview | 3-5ms |

## CLI Commands

```
codex-engine init [path]         Index + install config + generate docs
codex-engine search <query>      Search symbols
codex-engine callers <symbol>    Find callers
codex-engine context <symbol>    Full symbol context
codex-engine impact <file>       Impact analysis
codex-engine deps <symbol>       Dependencies
codex-engine rank                Top symbols by PageRank
codex-engine modules             Module map
codex-engine stats               Index statistics
codex-engine brief               Project summary (SessionStart hook)
codex-engine pre-edit <file>     Pre-edit context (PreToolUse hook)
codex-engine post-edit <file>    Post-edit reindex (PostToolUse hook)
codex-engine generate-docs       Regenerate CLAUDE.md
codex-engine mcp                 Run as MCP server
codex-engine uninstall           Remove all config
```

## Supported Languages

TypeScript, JavaScript, Python, Rust, Go, C, C++, Bash, JSON, CSS, HTML

## License

MIT
