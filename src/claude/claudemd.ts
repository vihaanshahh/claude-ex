import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { openDatabase } from '../db/schema';
import { getRank, getModules, getStats, getFileMapCompact } from '../query/engine';

const MARKER_START = '<!-- claude-ex:start -->';
const MARKER_END = '<!-- claude-ex:end -->';

export function generateClaudeMd(rootDir: string, db?: Database.Database): string {
    const shouldClose = !db;
    if (!db) db = openDatabase(rootDir);

    try {
        const stats = getStats(db);
        const topSymbols = getRank(db, 15);
        const modules = getModules(db);
        const dirname = path.basename(rootDir);

        // Language breakdown
        const langs = db.prepare(`
            SELECT language, COUNT(*) as cnt FROM files WHERE language IS NOT NULL GROUP BY language ORDER BY cnt DESC
        `).all() as { language: string; cnt: number }[];

        const lines: string[] = [];
        lines.push(MARKER_START);
        lines.push(`# Project: ${dirname}`);
        lines.push('');
        lines.push('## Architecture');
        lines.push(`- **Languages**: ${langs.map(l => `${l.language} (${l.cnt} files)`).join(', ')}`);
        lines.push(`- **Size**: ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} relationships`);
        lines.push('');

        if (topSymbols.length > 0) {
            lines.push('## Key Symbols (by structural importance)');
            for (let i = 0; i < topSymbols.length; i++) {
                const sym = topSymbols[i];
                lines.push(`${i + 1}. \`${sym.qualifiedName || sym.name}\` [${sym.kind}] in ${sym.file}`);
            }
            lines.push('');
        }

        if (modules.length > 0) {
            lines.push('## Module Map');
            for (const mod of modules.slice(0, 15)) {
                const imports = mod.importsFrom.length > 0
                    ? ` \u2192 imports from: ${mod.importsFrom.join(', ')}`
                    : ' \u2192 imports from: (none \u2014 leaf dependency)';
                lines.push(`${mod.name}/ (${mod.fileCount} files, ${mod.symbolCount} symbols)${imports}`);
            }
            lines.push('');
        }

        // File map — "where everything lives"
        const fileMap = getFileMapCompact(db);
        if (fileMap) {
            lines.push('## File Map (file → key exports)');
            lines.push('');
            lines.push(fileMap);
            lines.push('');
        }

        // MCP tool guidance — directive style so Claude actually uses them
        lines.push('## Codex MCP Tools — USE THESE');
        lines.push('');
        lines.push('This project has a live code index via MCP. **Always prefer these over grep/ripgrep for structural queries.** They are faster, rank-aware, and understand code relationships.');
        lines.push('');
        lines.push('### When to use which tool');
        lines.push('');
        lines.push('**Finding code** — use instead of Grep/Glob:');
        lines.push('- `search_code` — find symbols by name or description (PageRank-ranked). Use this FIRST for any "where is X" or "find X" query.');
        lines.push('- `find_files` — find files by glob pattern (e.g. `**/*.test.ts`). Use instead of shell find/ls.');
        lines.push('- `get_file_map` — full project map with every file and its exports. Use to orient yourself in an unfamiliar codebase.');
        lines.push('');
        lines.push('**Before modifying code** — always check impact:');
        lines.push('- `get_symbol` — full context for a symbol (code, deps, dependents, co-located symbols). Read this before editing any function/class.');
        lines.push('- `get_callers` — all callers of a function. Check before renaming, changing signatures, or deleting.');
        lines.push('- `get_dependents` — all files transitively affected if a file changes. Check before refactoring exports.');
        lines.push('- `get_dependencies` — what a symbol imports/uses.');
        lines.push('');
        lines.push('**Understanding structure:**');
        lines.push('- `get_file_symbols` — all symbols in a file (not just exports).');
        lines.push('- `find_by_kind` — find all classes, interfaces, enums, etc. across the project.');
        lines.push('- `get_type_hierarchy` — subclasses/implementors of a class or interface.');
        lines.push('- `get_pkg_usages` — files that import a given npm package (use before swapping libraries).');
        lines.push('- `get_architecture` — project overview with top symbols and module dependency map.');
        lines.push('');
        lines.push('**Maintenance:**');
        lines.push('- `find_dead_exports` — exported symbols nothing imports (dead code candidates).');
        lines.push('- `reindex_file` — re-index a file after major edits to keep results fresh.');
        lines.push('- `review_diff` — graph-aware diff review: changed symbols, callers, blast radius, risks.');
        lines.push('');
        lines.push('### Decision guide');
        lines.push('');
        lines.push('| You want to... | Use this | Not this |');
        lines.push('|---|---|---|');
        lines.push('| Find a function/class | `search_code` | Grep/ripgrep |');
        lines.push('| Find files by name | `find_files` | shell find/ls/Glob |');
        lines.push('| See what a file exports | `get_file_symbols` | Read entire file |');
        lines.push('| Check who calls X | `get_callers` | Grep for function name |');
        lines.push('| Understand blast radius | `get_dependents` | Manual file tracing |');
        lines.push('| Find a literal string/regex | Grep (built-in) | — |');
        lines.push('');

        // Development cycle — enforce process automatically
        lines.push('## Development Cycle — FOLLOW THIS');
        lines.push('');
        lines.push('For every code change, follow this cycle. Do not skip steps.');
        lines.push('');
        lines.push('### 1. Understand (before touching anything)');
        lines.push('- Run `search_code` or `get_file_map` to locate the relevant code.');
        lines.push('- Run `get_symbol` on every function/class you plan to modify — read its full context, dependencies, and dependents.');
        lines.push('- Run `get_callers` on any function whose signature, behavior, or name will change. Know who depends on it.');
        lines.push('- Run `get_dependents` on any file whose exports will change. Know the blast radius.');
        lines.push('- If unfamiliar with the area, run `get_architecture` to see how modules connect.');
        lines.push('');
        lines.push('### 2. Plan (decide what to change)');
        lines.push('- From step 1, you now know: what the code does, who calls it, and what breaks if it changes.');
        lines.push('- Identify all files and symbols that need updating (not just the primary target — include callers/dependents that must adapt).');
        lines.push('- If the change affects >3 files or an exported API, state the plan before writing code.');
        lines.push('');
        lines.push('### 3. Implement (make the change)');
        lines.push('- Edit the code. Prefer minimal, targeted changes.');
        lines.push('- Update all callers/dependents identified in step 2 — do not leave broken references.');
        lines.push('- After major edits to a file, run `reindex_file` so subsequent queries reflect your changes.');
        lines.push('');
        lines.push('### 4. Verify (confirm nothing broke)');
        lines.push('- Run `get_callers` again on modified symbols — verify every caller still works with the new signature/behavior.');
        lines.push('- Run `get_dependents` on modified files — verify no import is left broken.');
        lines.push('- Run tests if they exist (`npm test`, `pytest`, etc.).');
        lines.push('- If the project has a build step, run it (`npm run build`, `tsc --noEmit`, etc.).');
        lines.push('');
        lines.push('### 5. Review (before committing)');
        lines.push('- Run `review_diff` with target "staged" or "last_commit" to get a graph-aware review of your changes.');
        lines.push('- Check the risk assessment: high-importance symbols modified, cascade risks, broken imports.');
        lines.push('- If risks are flagged, go back to step 4 and address them.');
        lines.push('');
        lines.push('### Quick reference');
        lines.push('');
        lines.push('| Step | Tools | Gate |');
        lines.push('|---|---|---|');
        lines.push('| Understand | `search_code`, `get_symbol`, `get_callers`, `get_dependents` | Know the blast radius |');
        lines.push('| Plan | (your reasoning) | All affected files identified |');
        lines.push('| Implement | Edit + `reindex_file` | Code written |');
        lines.push('| Verify | `get_callers`, `get_dependents`, tests, build | No broken refs, tests pass |');
        lines.push('| Review | `review_diff` | No unaddressed risks |');
        lines.push('');
        lines.push('*Auto-generated by claude-ex. Run `claude-ex generate-docs` to regenerate.*');
        lines.push(MARKER_END);

        return lines.join('\n');
    } finally {
        if (shouldClose) db.close();
    }
}

export function writeClaudeMd(rootDir: string, db?: Database.Database): void {
    const content = generateClaudeMd(rootDir, db);
    const claudeMdPath = path.join(rootDir, 'CLAUDE.md');

    let updated: string;

    if (fs.existsSync(claudeMdPath)) {
        const existing = fs.readFileSync(claudeMdPath, 'utf-8');

        const startIdx = existing.indexOf(MARKER_START);
        const endIdx = existing.indexOf(MARKER_END);

        if (startIdx !== -1 && endIdx !== -1) {
            // Replace only the generated section, preserve everything before/after
            const before = existing.slice(0, startIdx);
            const after = existing.slice(endIdx + MARKER_END.length);
            updated = before + content + after;
        } else {
            // No markers yet — append with a blank line separator
            updated = existing.trimEnd() + '\n\n' + content + '\n';
        }

        // Skip write if nothing changed
        if (updated === existing) return;
    } else {
        updated = content + '\n';
    }

    fs.writeFileSync(claudeMdPath, updated);
}
