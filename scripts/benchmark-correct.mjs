/**
 * Correct Benchmark: Separate (CodeGraph + Engram) vs Integrated (CodeGraph with Engram)
 *
 * Baseline: codegraph_explore + searchEngramMemory (2 separate calls)
 * Integrated: codegraph_explore_with_memory (1 call)
 *
 * Run: node scripts/benchmark-correct.mjs
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraph } from '../dist/index.js';
import { ToolHandler } from '../dist/mcp/tools.js';
import { searchEngramMemory } from '../dist/integrations/engram-sync.js';
import { spawn } from 'node:child_process';

const FORD_MYCO_PATH = 'C:\\Users\\LuisOrozco\\Downloads\\Ford-MYCO';
const ENGRAM_STUB_SCRIPT = join(process.cwd(), 'scripts', 'engram-stub.mjs');

const QUERY = 'reporte';
const PROJECT_KEY = 'reportes-myco'; // Engram project key (from git_remote, not folder name)
const REPS = 10;

function startEngramStub() {
  // Use real Engram server (already running on port 7437)
  return Promise.resolve({
    url: 'http://localhost:7437',
    stop: () => { /* Don't stop real Engram */ },
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function textOf(result) {
  const first = result?.content?.[0];
  return (first && first.text) || '';
}

async function main() {
  console.log('=== Correct Benchmark: Separate vs Integrated ===\n');
  console.log('Repository: Ford-MYCO');
  console.log('Project Key: ' + PROJECT_KEY);
  console.log('Query: "' + QUERY + '"');
  console.log('Reps: ' + REPS + '\n');
  console.log('Baseline: CodeGraph explore + Engram search (2 calls)');
  console.log('Integrated: CodeGraph explore_with_memory (1 call)\n');

  // Open index
  console.log('[benchmark] Opening Ford-MYCO index...');
  const cg = await CodeGraph.open(FORD_MYCO_PATH);
  const handler = new ToolHandler(cg);
  console.log('[benchmark] Index opened\n');

  // Start Engram stub
  console.log('[benchmark] Starting Engram stub...');
  const engram = await startEngramStub();
  console.log('[benchmark] Engram stub running at: ' + engram.url + '\n');

  // Seed Engram
  console.log('[benchmark] Seeding Engram with insights...');
  process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
  process.env.ENGRAM_URL = engram.url;
  await cg.syncInsightsToEngram();
  console.log('[benchmark] Engram seeded\n');

  // Warmup
  console.log('[benchmark] Warming up...');
  await handler.execute('codegraph_explore', { query: QUERY, projectPath: FORD_MYCO_PATH });
  await searchEngramMemory(QUERY, { limit: 5, project: 'Ford-MYCO', engramUrl: engram.url });
  await handler.execute('codegraph_explore_with_memory', { query: QUERY, projectPath: FORD_MYCO_PATH });
  console.log('[benchmark] Warmup complete\n');

  // Measure baseline (separate calls)
  console.log('[benchmark] Measuring BASELINE (CodeGraph + Engram separate)...');
  const baselineRuns = [];
  for (let i = 0; i < REPS; i++) {
    const start = Date.now();
    
    // Call 1: CodeGraph explore
    const cgResult = await handler.execute('codegraph_explore', { query: QUERY, projectPath: FORD_MYCO_PATH });
    const cgText = textOf(cgResult);
    
    // Call 2: Engram search
    const engramResults = await searchEngramMemory(QUERY, { limit: 5, project: PROJECT_KEY, engramUrl: engram.url });
    
    const elapsed = Date.now() - start;
    const totalChars = cgText.length + JSON.stringify(engramResults).length;
    
    baselineRuns.push({ ms: elapsed, chars: totalChars, cg_chars: cgText.length, engram_results: engramResults.length });
    console.log('  Run ' + (i + 1) + ': ' + elapsed + 'ms, ' + totalChars + ' chars (CG: ' + cgText.length + ', Engram: ' + engramResults.length + ' results)');
  }

  // Measure integrated (single call)
  console.log('\n[benchmark] Measuring INTEGRATED (CodeGraph with Engram)...');
  const integratedRuns = [];
  for (let i = 0; i < REPS; i++) {
    const start = Date.now();
    
    // Single call: explore_with_memory
    const result = await handler.execute('codegraph_explore_with_memory', { query: QUERY, projectPath: FORD_MYCO_PATH });
    const text = textOf(result);
    const hasMemory = text.includes('Project Memory');
    
    const elapsed = Date.now() - start;
    
    integratedRuns.push({ ms: elapsed, chars: text.length, hasMemory });
    console.log('  Run ' + (i + 1) + ': ' + elapsed + 'ms, ' + text.length + ' chars' + (hasMemory ? ' [+memory]' : ''));
  }

  // Results
  const baselineMedian = median(baselineRuns.map(r => r.ms));
  const integratedMedian = median(integratedRuns.map(r => r.ms));
  const baselineChars = median(baselineRuns.map(r => r.chars));
  const integratedChars = median(integratedRuns.map(r => r.chars));
  const savings = baselineMedian - integratedMedian;
  const savingsPct = ((savings / baselineMedian) * 100).toFixed(1);
  const charsDiff = integratedChars - baselineChars;
  const hasMemoryCount = integratedRuns.filter(r => r.hasMemory).length;

  console.log('\n=== RESULTS ===');
  console.log('Baseline (separate):  ' + baselineMedian + 'ms, ' + baselineChars + ' chars');
  console.log('Integrated (1 call):  ' + integratedMedian + 'ms, ' + integratedChars + ' chars');
  console.log('Time savings:         ' + (savings >= 0 ? '+' : '') + savings + 'ms (' + savingsPct + '%)');
  console.log('Chars diff:           ' + (charsDiff >= 0 ? '+' : '') + charsDiff);
  console.log('Memory enrichment:    ' + hasMemoryCount + '/' + REPS + ' runs');

  // Cleanup
  console.log('\n[benchmark] Cleaning up...');
  await cg.close();
  engram.stop();
  console.log('[benchmark] Done');

  // Save
  const output = {
    timestamp: new Date().toISOString(),
    repository: 'Ford-MYCO',
    project_key: PROJECT_KEY,
    query: QUERY,
    reps: REPS,
    baseline_separate: {
      description: 'CodeGraph explore + Engram search (2 calls)',
      median_ms: baselineMedian,
      median_chars: baselineChars,
      runs: baselineRuns,
    },
    integrated: {
      description: 'CodeGraph explore_with_memory (1 call)',
      median_ms: integratedMedian,
      median_chars: integratedChars,
      runs: integratedRuns,
    },
    comparison: {
      time_savings_ms: savings,
      time_savings_pct: savingsPct,
      chars_diff: charsDiff,
      memory_enrichment: hasMemoryCount + '/' + REPS,
    },
  };

  const outputPath = join(process.cwd(), 'benchmark-correct-results.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Results saved to: ' + outputPath);
}

main().catch((err) => {
  console.error('[benchmark] FAILED:', err);
  process.exit(1);
});
