<!-- claude-ex:start -->
# Project: claude-ex

## Architecture
- **Languages**: typescript (18 files), json (4 files), javascript (1 files)
- **Size**: 23 files, 154 symbols, 460 relationships

## Key Symbols (by structural importance)
1. `openDatabase` [function] in src/db/schema.ts
2. `getCodexDir` [function] in src/utils.ts
3. `ensureCodexDir` [function] in src/utils.ts
4. `isSqliteCorruptionError` [function] in src/db/schema.ts
5. `resetDatabaseFiles` [function] in src/db/schema.ts
6. `initDb` [function] in src/db/schema.ts
7. `cached` [function] in src/query/engine.ts
8. `withDb` [function] in src/query/engine.ts
9. `getLanguage` [function] in src/indexer/parser.ts
10. `migrateSchema` [function] in src/db/schema.ts
11. `reindexFile` [function] in src/indexer/index.ts
12. `isSupportedFile` [function] in src/indexer/parser.ts
13. `getOrPrepare` [function] in src/db/schema.ts
14. `clearFileData` [function] in src/db/schema.ts
15. `walk` [function] in src/indexer/collector.ts

## Module Map
src/ (11 files, 144 symbols) → imports from: (none — leaf dependency)
./ (6 files, 6 symbols) → imports from: (none — leaf dependency)
tests/ (6 files, 4 symbols) → imports from: src

## File Map (file → key exports)

- `.mcp.json`
- `benchmark.js`
- `package-lock.json`
- `package.json`
- `src/claude/claudemd.ts` — writeClaudeMd, generateClaudeMd
- `src/claude/installer.ts` — install
- `src/claude/mcp.ts` — runMcpServer
- `src/db/schema.ts` — openDatabase, isSqliteCorruptionError, resetDatabaseFiles, clearFileData, getOrCreateFile, insertSymbol, insertEdge, insertPkgDep +6 more
- `src/index.ts`
- `src/indexer/collector.ts` — collectFiles
- `src/indexer/index.ts` — reindexFile, indexProject, IndexStats
- `src/indexer/parser.ts` — getLanguage, isSupportedFile, hashFile, parseFile, ExtractedParam, ExtractedSymbol, ExtractedImport, ExtractedCall +2 more
- `src/query/engine.ts` — getStats, getRank, getModules, search, getCallers, getImpact, getFileMapCompact, getContext +39 more
- `src/utils.ts` — getCodexDir, ensureCodexDir, findProjectRoot, formatMs, relativePath, truncate
- `src/watcher/daemon.ts` — startDaemon, stopDaemon, isDaemonRunning, startWatcher
- `tests/claudemd.test.ts`
- `tests/engine.test.ts`
- `tests/indexer.test.ts`
- `tests/installer.test.ts`
- `tests/perf.test.ts`
- `tests/schema.test.ts`
- `tsconfig.json`
- `vitest.config.ts`

## Codex MCP Tools — USE THESE

This project has a live code index via MCP. **Always prefer these over grep/ripgrep for structural queries.** They are faster, rank-aware, and understand code relationships.

### When to use which tool

**Finding code** — use instead of Grep/Glob:
- `get_task_context` — one-shot AI context pack from a task/query to ranked symbols, selected files, dependency context, and related files.
- `search_code` — find symbols by name or description (PageRank-ranked). Use this FIRST for any "where is X" or "find X" query.
- `find_files` — find files by glob pattern (e.g. `**/*.test.ts`). Use instead of shell find/ls.
- `get_file_map` — full project map with every file and its exports. Use to orient yourself in an unfamiliar codebase.

**Before modifying code** — always check impact:
- `get_symbol` — full context for a symbol (code, deps, dependents, co-located symbols). Read this before editing any function/class.
- `get_callers` — all callers of a function. Check before renaming, changing signatures, or deleting.
- `get_dependents` — all files transitively affected if a file changes. Check before refactoring exports.
- `get_dependencies` — what a symbol imports/uses.

**Understanding structure:**
- `get_file_symbols` — all symbols in a file (not just exports).
- `get_file_context` — best context around one or more files: symbols, imports, importers, callers, and ranked related files.
- `find_by_kind` — find all classes, interfaces, enums, etc. across the project.
- `get_type_hierarchy` — subclasses/implementors of a class or interface.
- `get_pkg_usages` — files that import a given npm package (use before swapping libraries).
- `get_architecture` — project overview with top symbols and module dependency map.

**Maintenance:**
- `find_dead_exports` — exported symbols nothing imports (dead code candidates).
- `reindex_file` — re-index a file after major edits to keep results fresh.
- `review_diff` — graph-aware diff review: changed symbols, callers, blast radius, risks.

### Decision guide

| You want to... | Use this | Not this |
|---|---|---|
| Find a function/class | `search_code` | Grep/ripgrep |
| Get context for a task | `get_task_context` | Multiple manual searches |
| Find files by name | `find_files` | shell find/ls/Glob |
| See what a file exports | `get_file_symbols` | Read entire file |
| Build file-centered context | `get_file_context` | Manual file tracing |
| Check who calls X | `get_callers` | Grep for function name |
| Understand blast radius | `get_dependents` | Manual file tracing |
| Find a literal string/regex | Grep (built-in) | — |

## Development Cycle — FOLLOW THIS

For every code change, follow this cycle. Do not skip steps.

### 1. Understand (before touching anything)
- Run `search_code` or `get_file_map` to locate the relevant code.
- Run `get_symbol` on every function/class you plan to modify — read its full context, dependencies, and dependents.
- Run `get_callers` on any function whose signature, behavior, or name will change. Know who depends on it.
- Run `get_dependents` on any file whose exports will change. Know the blast radius.
- If unfamiliar with the area, run `get_architecture` to see how modules connect.

### 2. Plan (decide what to change)
- From step 1, you now know: what the code does, who calls it, and what breaks if it changes.
- Identify all files and symbols that need updating (not just the primary target — include callers/dependents that must adapt).
- If the change affects >3 files or an exported API, state the plan before writing code.

### 3. Implement (make the change)
- Edit the code. Prefer minimal, targeted changes.
- Update all callers/dependents identified in step 2 — do not leave broken references.
- After major edits to a file, run `reindex_file` so subsequent queries reflect your changes.

### 4. Verify (confirm nothing broke)
- Run `get_callers` again on modified symbols — verify every caller still works with the new signature/behavior.
- Run `get_dependents` on modified files — verify no import is left broken.
- Run tests if they exist (`npm test`, `pytest`, etc.).
- If the project has a build step, run it (`npm run build`, `tsc --noEmit`, etc.).

### 5. Review (before committing)
- Run `review_diff` with target "staged" or "last_commit" to get a graph-aware review of your changes.
- Check the risk assessment: high-importance symbols modified, cascade risks, broken imports.
- If risks are flagged, go back to step 4 and address them.

### Quick reference

| Step | Tools | Gate |
|---|---|---|
| Understand | `search_code`, `get_symbol`, `get_callers`, `get_dependents` | Know the blast radius |
| Plan | (your reasoning) | All affected files identified |
| Implement | Edit + `reindex_file` | Code written |
| Verify | `get_callers`, `get_dependents`, tests, build | No broken refs, tests pass |
| Review | `review_diff` | No unaddressed risks |

*Auto-generated by claude-ex. Run `claude-ex generate-docs` to regenerate.*
<!-- claude-ex:end -->
