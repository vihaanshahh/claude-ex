# claude-ex

Local code intelligence layer for Claude Code. Indexes your codebase into a SQLite graph database (symbols + dependency edges + PageRank), then runs as a persistent MCP server that Claude Code queries in real-time.

Zero cloud. Zero API keys. Zero extra cost. Just your existing Claude Code subscription, supercharged.

## Quick Start

```bash
npm i -g claude-ex

cd /path/to/your/project
claude-ex init
```

That's it. Open Claude Code — the MCP server starts automatically and gives Claude structural awareness of your entire codebase.

## How It Works

1. **Indexes** your codebase using tree-sitter (functions, classes, methods, imports, call graphs)
2. **Computes PageRank** to identify structurally important symbols
3. **Runs as MCP server** with the SQLite database held open in memory — every query answers in <5ms
4. **Watches files** for changes and reindexes in <15ms
5. **Hooks into Claude Code** to inject context before/after edits

## Transparent Review (`transparent_review`)

Zero-black-box code review. Instead of dumping JSON metadata, it produces a **readable English narrative** that shows you exactly what changed and why it matters — no interpretation required.

### Usage

In Claude Code, use the `transparent_review` MCP tool, or from the CLI:

```
claude-ex transparent-review                Review the last commit
claude-ex transparent-review staged         Review staged changes
claude-ex transparent-review branch         Review current branch vs main (PR review)
claude-ex transparent-review abc1234        Review a specific commit
```

### What you get

For every changed symbol, the review shows:

1. **Exact before/after code** — the old version is found by name in git history, not by shifted line numbers
2. **Plain-English description** — "Partially modified. 2 lines added. Added error handling (try/catch). 1 new conditional branch."
3. **Per-symbol diff snippets** — the actual `+`/`-` lines scoped to that symbol
4. **Caller impact stories** — which functions in other files call the changed code, their source, and whether they'll break or just see behavior changes
5. **Blast radius by depth** — direct importers vs 2-3 levels deep, with symbol counts
6. **Risk assessment** — PageRank importance, cascade risk for widely-used exports, API signature changes, broken imports from deleted files

### Example output

```
## What Changed (file by file)

### `src/auth/session.ts` — modified
  +12 / -3 lines

#### `validateToken` — function (exported)

What changed: Partially modified. Signature changed. 1 new parameter(s) added.
Added error handling (try/catch). 1 new conditional branch.

[Before/After code shown inline]
[Diff snippet for this symbol]

---
## Who Gets Affected

2 caller(s) in other files use the changed exports:

- **handleRequest** in `src/routes/api.ts`
  calls validateToken. Signature changed, so this caller may need updating.
  [Caller code shown]

---
## Blast Radius

3 file(s) could be transitively affected:

Direct importers (2 files):
  - `src/routes/api.ts` (8 symbols)
  - `src/middleware/auth.ts` (3 symbols)

2 levels deep (1 file):
  - `src/app.ts` (12 symbols)
```

### How it differs from `review_diff`

| `review_diff` | `transparent_review` |
|---|---|
| Returns structured JSON | Returns readable markdown narrative |
| Lists changed symbol names | Shows actual before/after code |
| Lists affected dependents | Explains *how* each caller is affected |
| Risk flags as strings | Risk assessment with context and reasoning |
| You need to interpret the data | You read it and understand what happened |

## Code Review (`/review`)

Graph-aware code review, inspired by [Greptile](https://www.greptile.com). Uses the symbol graph to understand *what* changed, *who depends on it*, and *what could break* — then Claude writes a full review with that context.

### Usage

In Claude Code, type:

```
/review                  Review the last commit
/review staged           Review staged changes
/review branch           Review current branch vs main (PR review)
/review abc1234          Review a specific commit
```

### What it does

1. Parses the git diff and maps changed lines to symbols in the code graph
2. Finds all callers/dependents of changed exported symbols in other files
3. Computes transitive impact (files N levels deep that could break)
4. Flags risks: high-PageRank symbols modified, cascading exports, broken imports
5. Claude uses all this context to write an informed review with:
   - Summary of changes + blast radius
   - Risk assessment
   - File-by-file review with dependency awareness
   - Cross-file concerns
   - Verdict + action items

### When it helps most

- Multi-file refactors — catches "you changed X but 12 callers need updates"
- Exported API changes — flags widely-used exports that were modified
- Large PRs — risk signals help prioritize what to look at
- Deleted files — warns if something still imports from them

## MCP Tools

| Tool | What it does | Speed |
|------|-------------|-------|
| `search_code` | Hybrid FTS5 + PageRank search | 1-3ms |
| `get_symbol` | Full context for a symbol | 2-4ms |
| `get_callers` | Who calls this function | 1-3ms |
| `get_dependents` | What breaks if a file changes | 2-5ms |
| `get_dependencies` | What a symbol depends on | 1-3ms |
| `get_architecture` | Project overview | 3-5ms |
| `review_diff` | Graph-aware diff review context (structured JSON) | 10-50ms |
| `transparent_review` | Zero-black-box review narrative (readable English) | 15-80ms |

## CLI Commands

```
claude-ex init [path]                  Index + install config + generate docs
claude-ex transparent-review [target]  Zero-black-box review (before/after code, English, blast radius)
claude-ex review [target]              Graph-aware diff review (structured JSON)
claude-ex search <query>               Search symbols
claude-ex callers <symbol>             Find callers
claude-ex context <symbol>             Full symbol context
claude-ex impact <file>                Impact analysis
claude-ex deps <symbol>                Dependencies
claude-ex rank                         Top symbols by PageRank
claude-ex modules                      Module map
claude-ex stats                        Index statistics
claude-ex brief                        Project summary (SessionStart hook)
claude-ex pre-edit <file>              Pre-edit context (PreToolUse hook)
claude-ex post-edit <file>             Post-edit reindex (PostToolUse hook)
claude-ex generate-docs                Regenerate CLAUDE.md
claude-ex mcp                          Run as MCP server
claude-ex uninstall                    Remove all config
```

## Supported Languages

TypeScript, JavaScript, Python, Rust, Go, C, C++, Bash, JSON, CSS, HTML

## License

MIT
