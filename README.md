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

For Codex, register it during init:

```bash
claude-ex init --codex
```

That also writes a marker-safe `AGENTS.md` snippet and runs `codex mcp add claude-ex -- claude-ex mcp --no-watch /path/to/project`.

## How It Works

1. **Indexes** your codebase using tree-sitter (functions, classes, methods, imports, call graphs)
2. **Computes PageRank** to identify structurally important symbols
3. **Runs as MCP server** with the SQLite database held open in memory — every query answers in <5ms
4. **Watches files** for changes and reindexes in <15ms
5. **Generates CLAUDE.md** with a development cycle that Claude follows automatically

## What's New in 1.4.0

### Performance Overhaul

Every query is now faster. The entire engine was rewritten for speed:

- **Prepared statement cache** — SQL is compiled once per db connection, not per call. Every MCP tool invocation skips recompilation.
- **N+1 query elimination** — `getStats` (4 queries → 1), `getModules` (N+1 → 2), `getFileMap` / `getFileMapCompact` (N+1 → 1 via GROUP_CONCAT)
- **5 new indexes** — `files(path)`, `symbols(file_id, line_start)`, `file_deps(to_file, from_file)`, `symbols(exported, kind)`, `rankings(pagerank DESC)` — eliminates full table scans in hot-path queries
- **PageRank O(n) per iteration** — dangling node mass is pre-computed instead of O(n^2) inner loop
- **Import resolution** — uses pre-computed file set (0 `fs.existsSync` calls) instead of 11 syscalls per import
- **`transparentReview`** — 80 queries → 25 (lightweight code fetch instead of full `getContext` per caller)
- **Compact JSON** — MCP responses use `JSON.stringify(result)` instead of pretty-printed (30-50% smaller, 2x faster serialization)
- **Pre-warm on startup** — statement cache + SQLite page cache are warm before the first tool call

### Trigram Search

Substring and fuzzy matching, similar to Cursor's Instant Grep approach:

- New `symbols_trigram` FTS5 table with `tokenize='trigram'` for substring matches on symbol names, qualified names, and signatures
- **Two-pass search** — FTS5 word-level search first (fast, ranked), trigram fallback if results are sparse
- **FTS5 prefix index** (`prefix='2 4'`) — 80% faster prefix/autocomplete queries
- **NEAR phrase queries** — multi-token searches like `"get user"` use `NEAR` operator for better relevance, falling back to `OR` for partial matches

### Development Cycle in CLAUDE.md

The generated CLAUDE.md now includes a mandatory development cycle that Claude follows for every code change:

1. **Understand** — `search_code` → `get_symbol` → `get_callers` → `get_dependents` before touching anything
2. **Plan** — identify all affected files/symbols, state the plan if >3 files
3. **Implement** — edit code, update all callers, `reindex_file` after major changes
4. **Verify** — re-check callers/dependents, run tests and build
5. **Review** — `review_diff` for graph-aware risk assessment

Each step has a gate condition and a quick-reference table mapping steps to tools. Claude won't skip steps.

### CLAUDE.md Generator Improvements

- **Skip-if-unchanged** — won't rewrite the file if the generated section is identical (no more spurious git diffs)
- **Marker-safe** — only replaces content between `<!-- claude-ex:start -->` and `<!-- claude-ex:end -->`, preserving all user content before and after
- **Directive-style MCP docs** — decision guide table tells Claude exactly when to use each tool vs grep
- **Development cycle** — enforced process section (see above)

### Test Suite

93 tests across 5 files, runnable via `npm test`:

- **`tests/schema.test.ts`** (17) — database creation, tables, indexes, FTS, CRUD operations
- **`tests/engine.test.ts`** (25) — search, callers, context, impact, stats, file map, type hierarchy, dead exports, package usages
- **`tests/indexer.test.ts`** (10) — full index, file dependencies, PageRank, re-index, parser integration
- **`tests/claudemd.test.ts`** (11) — markers, user content preservation, skip-if-unchanged, development cycle
- **`tests/perf.test.ts`** (18) — performance gates (<50ms per query), data integrity (PageRank sum, no orphans, FTS sync)

### Other Improvements

- **Batch watcher debounce** — burst of file saves → single reindex batch (300ms window)
- **Memoized tool list** — MCP `ListTools` response allocated once, not per request
- **Cached insert statements** — `insertSymbol`, `insertEdge`, `insertPkgDep`, etc. use WeakMap-cached prepared statements

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

## MCP Tools

| Tool | What it does | Speed |
|------|-------------|-------|
| `search_code` | Hybrid FTS5 + trigram + PageRank search | <3ms |
| `get_symbol` | Full context for a symbol | <4ms |
| `get_callers` | Who calls this function | <3ms |
| `get_dependents` | What breaks if a file changes | <5ms |
| `get_dependencies` | What a symbol depends on | <3ms |
| `get_file_map` | Every file and its exports | <5ms |
| `get_file_symbols` | All symbols in a file | <3ms |
| `get_file_context` | Best context around files: symbols, imports, importers, callers, related files | <30ms |
| `get_task_context` | One-shot AI context pack from task/query to symbols, files, and related context | <50ms |
| `find_files` | Find files by glob pattern | <3ms |
| `find_by_kind` | All classes, interfaces, enums, etc. | <5ms |
| `get_type_hierarchy` | Subclasses/implementors | <3ms |
| `find_dead_exports` | Exported symbols nothing imports | <10ms |
| `get_pkg_usages` | Files importing a given package | <3ms |
| `get_architecture` | Project overview | <5ms |
| `reindex_file` | Re-index after edits | <15ms |
| `review_diff` | Graph-aware diff review (structured JSON) | 10-50ms |
| `transparent_review` | Zero-black-box review narrative (readable English) | 15-80ms |

## CLI Commands

```
claude-ex init [path]                  Index + install config + generate docs
claude-ex init [path] --codex          Also register the MCP server with Codex + write AGENTS.md
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
claude-ex mcp [path] [--no-watch]      Run as MCP server
claude-ex uninstall                    Remove all config
```

## Testing

```bash
npm test              Run all 93 tests
npm run test:watch    Watch mode
npm run prepush       Build + test (pre-push validation)
```

## Supported Languages

TypeScript, JavaScript, Python, Rust, Go, C, C++, Bash, JSON, CSS, HTML

## License

MIT
