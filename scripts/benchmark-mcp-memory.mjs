/**
 * Benchmark MCP memory path: handleExplore vs handleExploreWithMemory, in-process.
 *
 * Unlike benchmark-post-implementation.mjs (CLI explore + curl proxy), this
 * measures the REAL MCP tool path through ToolHandler against the live index.
 *
 * Requires: built dist/, indexed repo, Engram on :4199 (stub or real).
 * Run: ENGRAM_URL=http://localhost:4199 node scripts/benchmark-mcp-memory.mjs
 *
 * Output: docs/benchmarks/engram-integration-mcp-memory.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { CodeGraph } from '../dist/index.js';
import { ToolHandler } from '../dist/mcp/tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const QUERIES = [
  { name: 'single-symbol', query: 'CodeGraph.indexAll' },
  { name: 'flow-explore', query: 'CodeGraph sync indexAll' },
  { name: 'multi-symbol', query: 'ExtractionOrchestrator parseFile resolveReferences' },
];
const REPS = 3;

function textOf(result) {
  const first = result?.content?.[0];
  return (first && first.text) || '';
}

async function main() {
  console.log('[benchmark-mcp] Opening CodeGraph...');
  const cg = await CodeGraph.open(repoRoot);
  const handler = new ToolHandler(cg);

  // Warmup (not measured)
  console.log('[benchmark-mcp] Warming up...');
  await handler.execute('codegraph_explore', { query: QUERIES[0].query });

  const rows = [];
  for (const { name, query } of QUERIES) {
    console.log(`[benchmark-mcp] Measuring: ${name}`);
    const plain = [], enriched = [];
    for (let i = 0; i < REPS; i++) {
      let t = Date.now();
      const r1 = await handler.execute('codegraph_explore', { query });
      plain.push({ ms: Date.now() - t, chars: textOf(r1).length });

      t = Date.now();
      const r2 = await handler.execute('codegraph_explore_with_memory', { query });
      const text = textOf(r2);
      enriched.push({ ms: Date.now() - t, chars: text.length, hasMemory: text.includes('Project Memory') });
    }
    const med = (a) => [...a].sort((x, y) => x - y)[1];
    const row = {
      name, query,
      plain_ms: med(plain.map((p) => p.ms)),
      memory_ms: med(enriched.map((p) => p.ms)),
      plain_chars: med(plain.map((p) => p.chars)),
      memory_chars: med(enriched.map((p) => p.chars)),
      has_memory: enriched.some((p) => p.hasMemory),
    };
    row.overhead_ms = row.memory_ms - row.plain_ms;
    rows.push(row);
    console.log(`  plain: ${row.plain_ms}ms / memory: ${row.memory_ms}ms (overhead ${row.overhead_ms}ms, hasMemory=${row.has_memory})`);
  }

  const avg = (a) => Math.round(a.reduce((s, r) => s + r, 0) / a.length);
  const summary = {
    timestamp: new Date().toISOString(),
    repo: 'codegraph',
    commit: execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
    node_version: process.version,
    platform: process.platform,
    results: rows,
    avg_plain_ms: avg(rows.map((r) => r.plain_ms)),
    avg_memory_ms: avg(rows.map((r) => r.memory_ms)),
    avg_overhead_ms: avg(rows.map((r) => r.overhead_ms)),
  };

  const outDir = join(repoRoot, 'docs', 'benchmarks');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'engram-integration-mcp-memory.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n[benchmark-mcp] Saved to: ${outPath}`);
  console.log(`[benchmark-mcp] Avg overhead: ${summary.avg_overhead_ms}ms`);

  await cg.close();
}

main().catch((err) => {
  console.error('[benchmark-mcp] FAILED:', err);
  process.exit(1);
});
