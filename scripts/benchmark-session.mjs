/**
 * Session Benchmark: Measures real benefit of Engram cache
 *
 * Simulates a real user session:
 * - 3 new queries (CodeGraph + Engram)
 * - 7 repeated queries (memory cached)
 *
 * Run: node scripts/benchmark-session.mjs
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraph } from '../dist/index.js';
import { ToolHandler } from '../dist/mcp/tools.js';
import { searchEngramMemory } from '../dist/integrations/engram-sync.js';

const FORD_MYCO_PATH = 'C:\\Users\\LuisOrozco\\Downloads\\Ford-MYCO';
const PROJECT_KEY = 'reportes-myco';

// Session simulation: 10 queries total
// - 3 unique queries (will hit Engram)
// - 7 repeated queries (will hit cache)
const SESSION_QUERIES = [
  { query: 'reporte', type: 'new' },           // Query 1 - new
  { query: 'reporte German', type: 'new' },    // Query 2 - new
  { query: 'reporte MX', type: 'new' },        // Query 3 - new
  { query: 'reporte', type: 'repeat' },        // Query 4 - repeat (cache)
  { query: 'reporte German', type: 'repeat' }, // Query 5 - repeat (cache)
  { query: 'reporte', type: 'repeat' },        // Query 6 - repeat (cache)
  { query: 'reporte MX', type: 'repeat' },     // Query 7 - repeat (cache)
  { query: 'reporte', type: 'repeat' },        // Query 8 - repeat (cache)
  { query: 'reporte German', type: 'repeat' }, // Query 9 - repeat (cache)
  { query: 'reporte', type: 'repeat' },        // Query 10 - repeat (cache)
];

const REPS = 5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function textOf(result) {
  const first = result?.content?.[0];
  return (first && first.text) || '';
}

async function main() {
  console.log('=== Session Benchmark: Cache Benefit ===\n');
  console.log('Repository: Ford-MYCO');
  console.log('Project Key: ' + PROJECT_KEY);
  console.log('Session: 10 queries (3 new + 7 repeated)');
  console.log('Reps: ' + REPS + '\n');

  // Open index
  console.log('[benchmark] Opening Ford-MYCO index...');
  const cg = await CodeGraph.open(FORD_MYCO_PATH);
  const handler = new ToolHandler(cg);
  console.log('[benchmark] Index opened\n');

  // Warmup (first 3 queries to populate cache)
  console.log('[benchmark] Warming up (populating cache)...');
  for (const { query } of SESSION_QUERIES.slice(0, 3)) {
    await handler.execute('codegraph_explore', { query, projectPath: FORD_MYCO_PATH });
    await searchEngramMemory(query, { limit: 3, project: PROJECT_KEY, engramUrl: 'http://localhost:7437' });
  }
  console.log('[benchmark] Warmup complete\n');

  // Measure baseline (separate calls, no cache)
  console.log('[benchmark] Measuring BASELINE (separate, no cache)...');
  const baselineRuns = [];
  for (let rep = 0; rep < REPS; rep++) {
    const start = Date.now();
    for (const { query } of SESSION_QUERIES) {
      // Call 1: CodeGraph explore
      await handler.execute('codegraph_explore', { query, projectPath: FORD_MYCO_PATH });
      // Call 2: Engram search (always hits network)
      await searchEngramMemory(query, { limit: 3, project: PROJECT_KEY, engramUrl: 'http://localhost:7437' });
    }
    const elapsed = Date.now() - start;
    baselineRuns.push(elapsed);
    console.log('  Rep ' + (rep + 1) + ': ' + elapsed + 'ms for 10 queries');
  }

  // Measure integrated (with cache)
  console.log('\n[benchmark] Measuring INTEGRATED (with cache)...');
  const integratedRuns = [];
  for (let rep = 0; rep < REPS; rep++) {
    const start = Date.now();
    for (const { query } of SESSION_QUERIES) {
      // Single call: explore_with_memory (uses cache for repeats)
      await handler.execute('codegraph_explore_with_memory', { query, projectPath: FORD_MYCO_PATH });
    }
    const elapsed = Date.now() - start;
    integratedRuns.push(elapsed);
    console.log('  Rep ' + (rep + 1) + ': ' + elapsed + 'ms for 10 queries');
  }

  // Results
  const baselineMedian = median(baselineRuns);
  const integratedMedian = median(integratedRuns);
  const savings = baselineMedian - integratedMedian;
  const savingsPct = ((savings / baselineMedian) * 100).toFixed(1);

  console.log('\n=== RESULTS ===');
  console.log('Baseline (10 queries, no cache):  ' + baselineMedian + 'ms');
  console.log('Integrated (10 queries, with cache): ' + integratedMedian + 'ms');
  console.log('Time savings: ' + (savings >= 0 ? '+' : '') + savings + 'ms (' + savingsPct + '%)');
  console.log('Per-query average:');
  console.log('  Baseline:  ' + Math.round(baselineMedian / 10) + 'ms/query');
  console.log('  Integrated: ' + Math.round(integratedMedian / 10) + 'ms/query');

  // Cleanup
  console.log('\n[benchmark] Cleaning up...');
  await cg.close();
  console.log('[benchmark] Done');

  // Save
  const output = {
    timestamp: new Date().toISOString(),
    repository: 'Ford-MYCO',
    project_key: PROJECT_KEY,
    session_queries: SESSION_QUERIES.length,
    new_queries: 3,
    repeated_queries: 7,
    reps: REPS,
    baseline: {
      median_ms: baselineMedian,
      runs: baselineRuns,
    },
    integrated: {
      median_ms: integratedMedian,
      runs: integratedRuns,
    },
    comparison: {
      time_savings_ms: savings,
      time_savings_pct: savingsPct,
      baseline_per_query_ms: Math.round(baselineMedian / 10),
      integrated_per_query_ms: Math.round(integratedMedian / 10),
    },
  };

  const outputPath = join(process.cwd(), 'benchmark-session-results.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Results saved to: ' + outputPath);
}

main().catch((err) => {
  console.error('[benchmark] FAILED:', err);
  process.exit(1);
});
