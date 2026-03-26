---
name: review
description: >
  Codebase-aware code review using the code graph. Reviews the last commit,
  staged changes, or branch diff with full dependency and impact analysis.
  Triggers: "review", "/review", "code review", "review this PR", "review changes"
argument-hint: "[last_commit|staged|branch|<sha>]"
allowed-tools: mcp__codex__review_diff, mcp__codex__get_symbol, mcp__codex__get_callers, mcp__codex__search_code
---

# Code Review

Review the changes using the `review_diff` MCP tool with target "$ARGUMENTS" (default: "last_commit" if no argument provided).

## Steps

1. Call `review_diff` with the target to get graph-aware context (changed symbols, callers, impact, risks)
2. Analyze the structured result carefully
3. For any high-risk or complex changes, use `get_symbol` to read the full code of affected symbols
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
