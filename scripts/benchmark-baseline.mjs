/**
 * Benchmark Baseline: codegraph explore latency + token usage
 *
 * Measures current performance BEFORE Engram integration.
 * Run: node scripts/benchmark-baseline.mjs
 *
 * Output: docs/benchmarks/engram-integration-baseline.json
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Test queries representing typical agent explore patterns
const TEST_QUERIES = [
  { name: 'single-symbol', query: 'CodeGraph.indexAll' },
  { name: 'flow-explore', query: 'CodeGraph sync indexAll' },
  { name: 'multi-symbol', query: 'ExtractionOrchestrator parseFile resolveReferences' },
  { name: 'callers', query: 'ReferenceResolver' },
  { name: 'impact', query: 'GraphTraverser' },
];

// Warmup queries (not measured)
const WARMUP_QUERIES = ['CodeGraph.indexAll'];

function runExplore(query) {
  const start = Date.now();
  try {
    const result = execSync(
      `node dist/bin/codegraph.js explore "${query}"`,
      { cwd: repoRoot, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    const elapsed = Date.now() - start;
    // Parse markdown output: "Found N symbols across M files."
    const symbolsMatch = result.match(/Found (\d+) symbols/);
    const filesMatch = result.match(/across (\d+) files/);
    return {
      elapsed_ms: elapsed,
      chars: result.length,
      symbols_found: symbolsMatch ? parseInt(symbolsMatch[1], 10) : 0,
      files_found: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      success: true,
    };
  } catch (err) {
    return {
      elapsed_ms: Date.now() - start,
      chars: 0,
      symbols_found: 0,
      files_found: 0,
      success: false,
      error: err.message.slice(0, 200),
    };
  }
}

function main() {
  console.log('[benchmark] Starting baseline measurement...\n');

  // Warmup
  console.log('[benchmark] Warming up...');
  for (const q of WARMUP_QUERIES) {
    runExplore(q);
  }

  // Measure
  const results = [];
  for (const { name, query } of TEST_QUERIES) {
    console.log(`[benchmark] Measuring: ${name} — "${query}"`);
    const measurements = [];
    for (let i = 0; i < 3; i++) {
      const m = runExplore(query);
      measurements.push(m);
      console.log(`  run ${i + 1}: ${m.elapsed_ms}ms, ${m.chars} chars, ${m.symbols_found} symbols`);
    }

    // Take median
    const sorted = [...measurements].sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    const median = sorted[1];

    results.push({
      name,
      query,
      median_elapsed_ms: median.elapsed_ms,
      median_chars: median.chars,
      median_symbols: median.symbols_found,
      runs: measurements,
    });
  }

  const summary = {
    timestamp: new Date().toISOString(),
    repo: 'codegraph',
    commit: execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
    branch: execSync('git branch --show-current', { cwd: repoRoot }).toString().trim(),
    node_version: process.version,
    platform: process.platform,
    results,
    totals: {
      total_queries: results.length,
      avg_elapsed_ms: Math.round(results.reduce((s, r) => s + r.median_elapsed_ms, 0) / results.length),
      total_chars: results.reduce((s, r) => s + r.median_chars, 0),
    },
  };

  // Save
  const outDir = join(repoRoot, 'docs', 'benchmarks');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'engram-integration-baseline.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log(`\n[benchmark] Baseline saved to: ${outPath}`);
  console.log(`[benchmark] Avg latency: ${summary.totals.avg_elapsed_ms}ms`);
  console.log(`[benchmark] Total chars: ${summary.totals.total_chars}`);
}

main();
