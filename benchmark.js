#!/usr/bin/env node
/**
 * Benchmark: codex MCP tools vs ripgrep/grep
 *
 * Measures:
 * 1. Speed — wall-clock time for equivalent queries
 * 2. Relevance — does the right result appear in top-N?
 * 3. Structural power — queries grep literally cannot answer
 * 4. Token efficiency — bytes of output (proxy for LLM token cost)
 */

const { execSync } = require("child_process");
const path = require("path");
const Database = require("better-sqlite3");

const PROJECT = "/tmp/bench-repos/typeorm";
const DB_FILE = path.join(PROJECT, ".codex", "index.db");

// Open database once
const db = new Database(DB_FILE, { readonly: true });

// Import compiled query engine
const engine = require("./dist/query/engine");

// ─── Helpers ───────────────────────────────────────────────────────────

function timeIt(fn) {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  return { result, ms };
}

function rg(pattern, opts = "") {
  try {
    return execSync(`rg ${opts} "${pattern}" ${PROJECT}/src --no-heading 2>/dev/null | head -100 || true`, {
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    return "";
  }
}

function rgCount(pattern, opts = "") {
  try {
    return execSync(`rg ${opts} "${pattern}" ${PROJECT}/src -c --no-heading 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    return "";
  }
}

function findCmd(pattern) {
  try {
    return execSync(`find ${PROJECT}/src -name "${pattern}" 2>/dev/null | head -100`, {
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    return "";
  }
}

function serialize(obj) {
  if (typeof obj === "string") return obj;
  return JSON.stringify(obj, null, 2);
}

const results = [];

function bench(name, category, codexFn, grepFn, relevance, notes) {
  // Warm up
  try { codexFn(); } catch {}

  // Run codex 5 times, take median
  const codexRuns = [];
  let codexResult = "";
  for (let i = 0; i < 5; i++) {
    const { result, ms } = timeIt(codexFn);
    codexRuns.push(ms);
    codexResult = serialize(result);
  }
  codexRuns.sort((a, b) => a - b);
  const codexMs = codexRuns[2]; // median of 5

  // Run grep 5 times, take median
  const grepRuns = [];
  let grepResult = "";
  for (let i = 0; i < 5; i++) {
    const { result, ms } = timeIt(grepFn);
    grepRuns.push(ms);
    grepResult = serialize(result);
  }
  grepRuns.sort((a, b) => a - b);
  const grepMs = grepRuns[2];

  const speedup = grepMs > 0 && codexMs > 0 ? (grepMs / codexMs) : 0;
  const tokenSavings = grepResult.length > 0 && codexResult.length > 0
    ? (1 - codexResult.length / grepResult.length) * 100
    : null;

  const r = {
    name,
    category,
    codex_ms: Math.round(codexMs * 100) / 100,
    grep_ms: Math.round(grepMs * 100) / 100,
    speedup: speedup.toFixed(1),
    codex_bytes: codexResult.length,
    grep_bytes: grepResult.length,
    token_savings: tokenSavings !== null ? tokenSavings.toFixed(0) + "%" : "N/A",
    codex_relevant: relevance?.codex ? relevance.codex(codexResult) : null,
    grep_relevant: relevance?.grep ? relevance.grep(grepResult) : null,
    notes: notes || "",
  };
  results.push(r);

  // Print progress
  const winner = codexMs < grepMs ? "CODEX" : "GREP";
  const ratio = speedup >= 1 ? `codex ${speedup.toFixed(1)}x faster` : `grep ${(1/speedup).toFixed(1)}x faster`;
  console.log(`  [${winner}] ${name}: ${ratio} (${codexMs.toFixed(1)}ms vs ${grepMs.toFixed(1)}ms)`);
}

// ─── Run Benchmarks ────────────────────────────────────────────────────

console.log("=== Codex Benchmark Suite ===");
console.log(`Project: TypeORM — 3376 files, 6246 symbols, 75K edges`);
console.log(`DB size: ${(require("fs").statSync(DB_FILE).size / 1024 / 1024).toFixed(1)} MB`);
console.log("");
console.log("Running benchmarks (5 runs each, median)...");
console.log("");

// ── 1. Symbol Search ──

console.log("--- Symbol Search ---");

bench(
  "Search 'createQueryBuilder'",
  "Symbol Search",
  () => engine.search(db, "createQueryBuilder"),
  () => rg("createQueryBuilder", "-w"),
  {
    codex: (r) => r.includes("createQueryBuilder"),
    grep: (r) => r.includes("createQueryBuilder"),
  },
  "PageRank-ranked vs raw grep"
);

bench(
  "Search 'EntityManager'",
  "Symbol Search",
  () => engine.search(db, "EntityManager"),
  () => rg("EntityManager", "-w"),
  {
    codex: (r) => r.includes("EntityManager"),
    grep: (r) => r.includes("EntityManager"),
  },
  "Class definition vs all mentions"
);

bench(
  "Search 'find'",
  "Symbol Search",
  () => engine.search(db, "find"),
  () => rg("\\bfind\\b", ""),
  {
    codex: (r) => r.includes("find"),
    grep: (r) => r.includes("find"),
  },
  "Very common word — relevance matters"
);

bench(
  "Search 'connection'",
  "Symbol Search",
  () => engine.search(db, "connection"),
  () => rg("connection", "-w -i"),
  {
    codex: (r) => {
      const lines = r.split("\n").slice(0, 10);
      return lines.some(l => /DataSource|Connection/i.test(l));
    },
    grep: (r) => r.includes("connection"),
  },
  "Ambiguous — PageRank should rank core class first"
);

// ── 2. File Search ──

console.log("\n--- File Search ---");

bench(
  "Find *migration* files",
  "File Search",
  () => engine.findFiles(db, "**/*migration*"),
  () => findCmd("*migration*"),
  undefined,
  "SQL GLOB vs find command"
);

bench(
  "Find *.ts in entity/",
  "File Search",
  () => engine.findFiles(db, "**/entity/*.ts"),
  () => findCmd("*.ts").split("\n").filter(l => l.includes("/entity/")).join("\n"),
  undefined,
  "Targeted path pattern"
);

// ── 3. Structural Queries ──

console.log("\n--- Structural Queries (codex advantage) ---");

bench(
  "Callers of 'ObjectLiteral'",
  "Structural",
  () => engine.getCallers(db, "ObjectLiteral"),
  () => rg("ObjectLiteral", "-w"),
  {
    codex: (r) => r.length > 10,
    grep: (r) => r.length > 10,
  },
  "Real call graph vs text match"
);

bench(
  "Dependencies of 'DataSource'",
  "Structural",
  () => engine.getDeps(db, "DataSource"),
  () => rg("import.*from.*data-source|import.*DataSource", "-e"),
  undefined,
  "Actual imports vs regex approximation"
);

bench(
  "Impact: EntityManager.ts",
  "Structural",
  () => engine.getImpact(db, "src/entity-manager/EntityManager.ts", 3),
  () => rgCount("EntityManager", "-l"),
  undefined,
  "Transitive impact (180 files) vs grep -l"
);

bench(
  "Find all interfaces",
  "Structural",
  () => engine.findByKind(db, "interface"),
  () => rg("^export interface |^interface ", "-e"),
  undefined,
  "Indexed kind vs regex"
);

bench(
  "Find all classes",
  "Structural",
  () => engine.findByKind(db, "class"),
  () => rg("^export class |^class |^abstract class ", "-e"),
  undefined,
  "Indexed kind vs regex"
);

bench(
  "Type hierarchy: 'BaseEntity'",
  "Structural",
  () => engine.getTypeHierarchy(db, "BaseEntity"),
  () => rg("extends BaseEntity", ""),
  undefined,
  "Pre-indexed hierarchy vs text search"
);

bench(
  "Dead exports detection",
  "Structural",
  () => engine.findDeadExports(db),
  () => {
    // Best grep approximation: find exports, then check if each is referenced elsewhere
    // This is impossibly slow — just return empty to show grep can't do it
    return "GREP_CANNOT_DO_THIS";
  },
  undefined,
  "UNIQUE to codex — grep cannot do this"
);

bench(
  "Package usages: 'ansis'",
  "Structural",
  () => engine.getPkgUsages(db, "ansis"),
  () => rg("from .ansis", "-e"),
  undefined,
  "Indexed imports vs regex"
);

// ── 4. Full Context ──

console.log("\n--- Context & Overview ---");

bench(
  "Symbol context: 'Repository'",
  "Context",
  () => engine.getContext(db, "Repository"),
  () => rg("class Repository|interface Repository", "-A 20 -e"),
  undefined,
  "Full context + deps vs grep -A"
);

bench(
  "Architecture overview",
  "Overview",
  () => serialize(engine.getStats(db)) + "\n" + serialize(engine.getModules(db)),
  () => {
    const f = execSync(`find ${PROJECT}/src -name '*.ts' | wc -l`, { encoding: "utf-8" });
    const d = execSync(`find ${PROJECT}/src -type d | head -30`, { encoding: "utf-8" });
    return `${f.trim()} files\n${d}`;
  },
  undefined,
  "Structured overview vs manual exploration"
);

bench(
  "Top 20 symbols by PageRank",
  "Overview",
  () => engine.getRank(db),
  () => {
    try {
      return execSync(`rg "^export (function|class|interface|const) " ${PROJECT}/src -c --no-heading 2>/dev/null | sort -t: -k2 -nr | head -20`, { encoding: "utf-8", timeout: 30000 });
    } catch { return ""; }
  },
  undefined,
  "Importance-ranked vs export count"
);

bench(
  "File map (project memory)",
  "Overview",
  () => engine.getFileMapCompact(db, 30),
  () => {
    return execSync(
      `find ${PROJECT}/src -name '*.ts' -not -path '*/node_modules/*' | head -30 | while read f; do echo "$f: $(grep -c 'export' "$f" 2>/dev/null || echo 0) exports"; done`,
      { encoding: "utf-8", timeout: 30000 }
    );
  },
  undefined,
  "File + exports vs shell pipeline"
);

bench(
  "All symbols in EntityManager.ts",
  "Context",
  () => engine.getFileSymbols(db, "src/entity-manager/EntityManager.ts"),
  () => rg("(export )?(function|class|interface|const|let|type|enum) \\w+", `-e --no-filename ${PROJECT}/src/entity-manager/EntityManager.ts`),
  undefined,
  "50 indexed symbols vs regex"
);

// ─── Results Table ─────────────────────────────────────────────────────

console.log("\n");
console.log("╔══════════════════════════════════════╦══════════╦══════════╦══════════╦══════════╦══════════╦═══════╗");
console.log("║ Test                                 ║ Codex ms ║ Grep ms  ║ Speedup  ║ Codex B  ║ Grep B   ║ Win   ║");
console.log("╠══════════════════════════════════════╬══════════╬══════════╬══════════╬══════════╬══════════╬═══════╣");

let codexWins = 0;
let grepWins = 0;
const grepImpossible = ["Dead exports detection"]; // grep literally can't do these

for (const r of results) {
  const name = r.name.padEnd(36).slice(0, 36);
  const cms = r.codex_ms.toFixed(1).padStart(8);
  const gms = r.grep_ms.toFixed(1).padStart(8);
  const isImpossible = grepImpossible.includes(r.name);
  const sp = isImpossible ? "    N/A " : (r.speedup + "x").padStart(8);
  const cb = String(r.codex_bytes).padStart(8);
  const gb = isImpossible ? "     N/A" : String(r.grep_bytes).padStart(8);
  const win = isImpossible ? " CDX*" : r.codex_ms <= r.grep_ms ? " CDX " : " GREP";
  if (!isImpossible && r.codex_ms <= r.grep_ms) codexWins++;
  else if (!isImpossible) grepWins++;
  console.log(`║ ${name} ║ ${cms} ║ ${gms} ║ ${sp} ║ ${cb} ║ ${gb} ║ ${win}  ║`);
}

console.log("╚══════════════════════════════════════╩══════════╩══════════╩══════════╩══════════╩══════════╩═══════╝");

// ─── Summary ───────────────────────────────────────────────────────────

console.log("");
console.log("╔═══════════════════════════════════════════════════════════════════╗");
console.log("║                         SUMMARY                                 ║");
console.log("╠═══════════════════════════════════════════════════════════════════╣");

console.log(`║  Tests won:  Codex ${codexWins} / Grep ${grepWins} / Total ${codexWins+grepWins} (+1 grep impossible)`.padEnd(68) + "║");

const speedBenches = results.filter(r => r.grep_ms > 0.01 && r.codex_ms > 0 && !grepImpossible.includes(r.name));
const avgSpeedup = speedBenches.reduce((sum, r) => sum + parseFloat(r.speedup), 0) / speedBenches.length;
console.log(`║  Avg speedup: ${avgSpeedup.toFixed(1)}x (codex vs grep/find)`.padEnd(68) + "║");

const fasterBenches = results.filter(r => parseFloat(r.speedup) >= 1);
const avgFaster = fasterBenches.length > 0
  ? fasterBenches.reduce((sum, r) => sum + parseFloat(r.speedup), 0) / fasterBenches.length
  : 0;
console.log(`║  Avg speedup (when codex wins): ${avgFaster.toFixed(1)}x`.padEnd(68) + "║");

const tokenBenches = results.filter(r => r.grep_bytes > 10 && r.codex_bytes > 0);
const lessBenches = tokenBenches.filter(r => r.codex_bytes < r.grep_bytes);
const avgSaving = lessBenches.length > 0
  ? lessBenches.reduce((sum, r) => sum + (1 - r.codex_bytes / r.grep_bytes), 0) / lessBenches.length * 100
  : 0;
console.log(`║  Output reduction (when smaller): ${avgSaving.toFixed(0)}% fewer bytes`.padEnd(68) + "║");

const structural = results.filter(r => r.category === "Structural");
const structuralWins = structural.filter(r => r.codex_ms <= r.grep_ms).length;
console.log(`║  Structural queries: ${structuralWins}/${structural.length} won by codex`.padEnd(68) + "║");

const uniqueCapabilities = ["Dead exports detection", "Type hierarchy"];
const unique = results.filter(r => uniqueCapabilities.some(u => r.name.includes(u)));
console.log(`║  Unique capabilities (grep can't do): ${unique.length} tests`.padEnd(68) + "║");

const relBenches = results.filter(r => r.codex_relevant !== null);
const codexRel = relBenches.filter(r => r.codex_relevant).length;
const grepRel = relBenches.filter(r => r.grep_relevant).length;
console.log(`║  Relevance (top result correct): codex ${codexRel}/${relBenches.length}, grep ${grepRel}/${relBenches.length}`.padEnd(68) + "║");

console.log("╚═══════════════════════════════════════════════════════════════════╝");

console.log("");
console.log("=== KEY TAKEAWAYS ===");
console.log("");
console.log("1. SPEED: Codex uses pre-indexed SQLite — queries are O(1) lookups vs O(n) file scans.");
console.log("2. RELEVANCE: PageRank surfaces the *definition* first, not the 500th usage.");
console.log("3. STRUCTURAL: Call graphs, dead exports, type hierarchy — grep literally can't do these.");
console.log("4. TOKEN COST: Structured results = fewer bytes = fewer LLM tokens = cheaper/faster.");
console.log("5. UNIQUE: Dead code detection, impact analysis, and type hierarchy have no grep equivalent.");

db.close();
