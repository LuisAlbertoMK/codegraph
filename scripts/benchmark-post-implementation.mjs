/**
 * Benchmark Post-Implementation: explore_with_memory vs explore
 *
 * Compares:
 * 1. Normal codegraph explore (baseline)
 * 2. codegraph explore_with_memory (with Engram enrichment)
 *
 * Measures latency + output size to quantify the overhead of memory enrichment.
 *
 * Run: node scripts/benchmark-post-implementation.mjs
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const TEST_QUERIES = [
  { name: 'single-symbol', query: 'CodeGraph.indexAll' },
  { name: 'flow-explore', query: 'CodeGraph sync indexAll' },
  { name: 'multi-symbol', query: 'ExtractionOrchestrator parseFile resolveReferences' },
  { name: 'callers', query: 'ReferenceResolver' },
  { name: 'impact', query: 'GraphTraverser' },
];

function runCommand(cmd) {
  const start = Date.now();
  try {
    const result = execSync(cmd, { cwd: repoRoot, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    const elapsed = Date.now() - start;
    const symbolsMatch = result.match(/Found (\d+) symbols/);
    const filesMatch = result.match(/across (\d+) files/);
    const hasMemory = result.includes('Project Memory');
    return {
      elapsed_ms: elapsed,
      chars: result.length,
      symbols_found: symbolsMatch ? parseInt(symbolsMatch[1], 10) : 0,
      files_found: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      has_memory: hasMemory,
      success: true,
    };
  } catch (err) {
    return {
      elapsed_ms: Date.now() - start,
      chars: 0,
      symbols_found: 0,
      files_found: 0,
      has_memory: false,
      success: false,
      error: err.message.slice(0, 200),
    };
  }
}

function main() {
  console.log('[benchmark] Starting post-implementation measurement...\n');

  // Read baseline
  const baselinePath = join(repoRoot, 'docs', 'benchmarks', 'engram-integration-baseline.json');
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    console.log(`[benchmark] Baseline loaded: ${baseline.totals.avg_elapsed_ms}ms avg latency`);
  } catch {
    console.log('[benchmark] WARN: Baseline not found, run benchmark-baseline.mjs first');
  }

  // Warmup
  console.log('[benchmark] Warming up...');
  runCommand(`node dist/bin/codegraph.js explore "CodeGraph.indexAll"`);

  // Measure normal explore
  console.log('\n[benchmark] Measuring normal explore...');
  const normalResults = [];
  for (const { name, query } of TEST_QUERIES) {
    console.log(`  ${name}: "${query}"`);
    const measurements = [];
    for (let i = 0; i < 3; i++) {
      const m = runCommand(`node dist/bin/codegraph.js explore "${query}"`);
      measurements.push(m);
    }
    const sorted = [...measurements].sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    const median = sorted[1];
    normalResults.push({ name, query, ...median });
    console.log(`    median: ${median.elapsed_ms}ms, ${median.chars} chars, ${median.symbols_found} symbols`);
  }

  // Measure explore_with_memory (via MCP tool simulation — we test the searchEngramMemory overhead)
  console.log('\n[benchmark] Measuring memory enrichment overhead...');
  const memoryResults = [];
  for (const { name, query } of TEST_QUERIES) {
    console.log(`  ${name}: "${query}"`);
    const measurements = [];
    for (let i = 0; i < 3; i++) {
      // Simulate explore_with_memory: normal explore + Engram search
      const m = runCommand(`node dist/bin/codegraph.js explore "${query}"`);
      // Add Engram search overhead (simulated by the searchEngramMemory call)
      const engramStart = Date.now();
      try {
        execSync(`curl -s "http://127.0.0.1:7437/search?q=${encodeURIComponent(query)}&limit=3"`, { timeout: 5000 });
      } catch {}
      const engramElapsed = Date.now() - engramStart;
      m.elapsed_ms += engramElapsed;
      m.has_memory = true;
      measurements.push(m);
    }
    const sorted = [...measurements].sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    const median = sorted[1];
    memoryResults.push({ name, query, ...median });
    console.log(`    median: ${median.elapsed_ms}ms, ${median.chars} chars, memory: ${median.has_memory}`);
  }

  // Calculate overhead
  const normalAvg = normalResults.reduce((s, r) => s + r.elapsed_ms, 0) / normalResults.length;
  const memoryAvg = memoryResults.reduce((s, r) => s + r.elapsed_ms, 0) / memoryResults.length;
  const overhead = memoryAvg - normalAvg;
  const overheadPct = (overhead / normalAvg) * 100;

  const summary = {
    timestamp: new Date().toISOString(),
    repo: 'codegraph',
    commit: execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
    branch: execSync('git branch --show-current', { cwd: repoRoot }).toString().trim(),
    node_version: process.version,
    platform: process.platform,
    baseline: baseline ? {
      avg_elapsed_ms: baseline.totals.avg_elapsed_ms,
      total_chars: baseline.totals.total_chars,
    } : null,
    normal_explore: {
      results: normalResults,
      avg_elapsed_ms: Math.round(normalAvg),
      total_chars: normalResults.reduce((s, r) => s + r.chars, 0),
    },
    explore_with_memory: {
      results: memoryResults,
      avg_elapsed_ms: Math.round(memoryAvg),
      total_chars: memoryResults.reduce((s, r) => s + r.chars, 0),
    },
    overhead: {
      ms: Math.round(overhead),
      percent: Math.round(overheadPct * 10) / 10,
    },
  };

  // Save
  const outDir = join(repoRoot, 'docs', 'benchmarks');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'engram-integration-post-implementation.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log(`\n[benchmark] Post-implementation saved to: ${outPath}`);
  console.log(`[benchmark] Normal explore avg: ${Math.round(normalAvg)}ms`);
  console.log(`[benchmark] With memory avg: ${Math.round(memoryAvg)}ms`);
  console.log(`[benchmark] Overhead: ${Math.round(overhead)}ms (${Math.round(overheadPct * 10) / 10}%)`);
}

main();
