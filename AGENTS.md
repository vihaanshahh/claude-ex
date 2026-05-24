<!-- claude-ex:agents:start -->
# claude-ex

Use the `claude-ex` MCP server for structural codebase tasks before falling back to broad text search.

Prefer MCP for:
- symbol search and code discovery
- callers, dependents, dependencies, and type hierarchy
- architecture, file maps, and package usage
- graph-aware diff review

Use the following tools when they match the task:
- `search_code`
- `get_symbol`
- `get_callers`
- `get_dependents`
- `get_dependencies`
- `get_architecture`
- `get_file_map`
- `find_files`
- `get_file_symbols`
- `get_file_context`
- `get_task_context`
- `find_by_kind`
- `get_type_hierarchy`
- `find_dead_exports`
- `get_pkg_usages`
- `review_diff`
- `transparent_review`

Use grep/ripgrep for plain text and regex-only searches like TODOs, exact literals, or log lines.
<!-- claude-ex:agents:end -->
