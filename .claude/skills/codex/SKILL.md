---
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
