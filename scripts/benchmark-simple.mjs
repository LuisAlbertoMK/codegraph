/**
 * Simple Benchmark: Baseline vs Engram on Ford-MYCO
 *
 * Run: node scripts/benchmark-simple.mjs
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraph } from '../dist/index.js';
import { ToolHandler } from '../dist/mcp/tools.js';
import { spawn } from 'node:child_process';

const FORD_MYCO_PATH = 'C:\\Users\\LuisOrozco\\Downloads\\Ford-MYCO';
const ENGRAM_STUB_SCRIPT = join(process.cwd(), 'scripts', 'engram-stub.mjs');

const QUERY = 'authentication login';
const REPS = 10;

function startEngramStub() {
  return new Promise((resolve, reject) => {
    const port = 4700 + Math.floor(Math.random() * 100);
    const url = 'http://localhost:' + port;

    const stub = spawn('node', [ENGRAM_STUB_SCRIPT], {
      env: { ...process.env, ENGRAM_STUB_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      reject(new Error('Engram stub failed to start within 5s'));
    }, 5000);

    stub.stdout?.on('data', (data) => {
      if (data.toString().includes('Listening')) {
        clearTimeout(timeout);
        resolve({
          url: url,
          stop: () => stub.kill('SIGTERM'),
        });
      }
    });

    stub.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
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
  console.log('=== Simple Benchmark: Baseline vs Engram ===\n');
  console.log('Repository: Ford-MYCO');
  console.log('Query: "' + QUERY + '"');
  console.log('Reps: ' + REPS + '\n');

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
  await handler.execute('codegraph_explore_with_memory', { query: QUERY, projectPath: FORD_MYCO_PATH });
  console.log('[benchmark] Warmup complete\n');

  // Measure baseline
  console.log('[benchmark] Measuring BASELINE (no Engram)...');
  const baselineRuns = [];
  for (let i = 0; i < REPS; i++) {
    const start = Date.now();
    const result = await handler.execute('codegraph_explore', { query: QUERY, projectPath: FORD_MYCO_PATH });
    const elapsed = Date.now() - start;
    const text = textOf(result);
    baselineRuns.push({ ms: elapsed, chars: text.length });
    console.log('  Run ' + (i + 1) + ': ' + elapsed + 'ms, ' + text.length + ' chars');
  }

  // Measure with Engram
  console.log('\n[benchmark] Measuring WITH ENGRAM...');
  const memoryRuns = [];
  for (let i = 0; i < REPS; i++) {
    const start = Date.now();
    const result = await handler.execute('codegraph_explore_with_memory', { query: QUERY, projectPath: FORD_MYCO_PATH });
    const elapsed = Date.now() - start;
    const text = textOf(result);
    const hasMemory = text.includes('Project Memory');
    memoryRuns.push({ ms: elapsed, chars: text.length, hasMemory });
    console.log('  Run ' + (i + 1) + ': ' + elapsed + 'ms, ' + text.length + ' chars' + (hasMemory ? ' [+memory]' : ''));
  }

  // Results
  const baselineMedian = median(baselineRuns.map(r => r.ms));
  const memoryMedian = median(memoryRuns.map(r => r.ms));
  const baselineChars = median(baselineRuns.map(r => r.chars));
  const memoryChars = median(memoryRuns.map(r => r.chars));
  const overhead = memoryMedian - baselineMedian;
  const overheadPct = ((overhead / baselineMedian) * 100).toFixed(1);
  const charsDiff = memoryChars - baselineChars;
  const hasMemoryCount = memoryRuns.filter(r => r.hasMemory).length;

  console.log('\n=== RESULTS ===');
  console.log('Baseline:  ' + baselineMedian + 'ms, ' + baselineChars + ' chars');
  console.log('With Engram: ' + memoryMedian + 'ms, ' + memoryChars + ' chars');
  console.log('Overhead:   ' + (overhead >= 0 ? '+' : '') + overhead + 'ms (' + overheadPct + '%)');
  console.log('Chars diff: ' + (charsDiff >= 0 ? '+' : '') + charsDiff);
  console.log('Memory enrichment: ' + hasMemoryCount + '/' + REPS + ' runs');

  // Cleanup
  console.log('\n[benchmark] Cleaning up...');
  await cg.close();
  engram.stop();
  console.log('[benchmark] Done');

  // Save
  const output = {
    timestamp: new Date().toISOString(),
    repository: 'Ford-MYCO',
    query: QUERY,
    reps: REPS,
    baseline: {
      median_ms: baselineMedian,
      median_chars: baselineChars,
      runs: baselineRuns,
    },
    with_engram: {
      median_ms: memoryMedian,
      median_chars: memoryChars,
      runs: memoryRuns,
    },
    comparison: {
      overhead_ms: overhead,
      overhead_pct: overheadPct,
      chars_diff: charsDiff,
      memory_enrichment: hasMemoryCount + '/' + REPS,
    },
  };

  const outputPath = join(process.cwd(), 'benchmark-simple-results.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Results saved to: ' + outputPath);
}

main().catch((err) => {
  console.error('[benchmark] FAILED:', err);
  process.exit(1);
});
