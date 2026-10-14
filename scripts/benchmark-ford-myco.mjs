/**
 * Benchmark: Ford-MYCO repository with Engram integration
 *
 * Measures the real benefit of Engram integration on the Ford-MYCO repository
 * by comparing codegraph_explore vs codegraph_explore_with_memory.
 *
 * Run: node scripts/benchmark-ford-myco.mjs
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraph } from '../dist/index.js';
import { ToolHandler } from '../dist/mcp/tools.js';
import { spawn } from 'node:child_process';

const FORD_MYCO_PATH = 'C:\\Users\\LuisOrozco\\Downloads\\Ford-MYCO';
const ENGRAM_STUB_SCRIPT = join(process.cwd(), 'scripts', 'engram-stub.mjs');

// Test queries representing typical agent explore patterns for Ford-MYCO
const TEST_QUERIES = [
  { name: 'auth-flow', query: 'authentication login', description: 'Authentication flow' },
  { name: 'api-endpoint', query: 'API endpoint controller', description: 'API endpoint lookup' },
  { name: 'database', query: 'database model schema', description: 'Database model exploration' },
  { name: 'service-layer', query: 'service business logic', description: 'Service layer exploration' },
  { name: 'config', query: 'configuration settings', description: 'Configuration exploration' },
];

const REPS = 5;

function startEngramStub() {
  return new Promise((resolve, reject) => {
    const port = 4600 + Math.floor(Math.random() * 100);
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
  console.log('=== Ford-MYCO Benchmark: Engram Integration Benefit ===\n');
  console.log('Repository: ' + FORD_MYCO_PATH);
  console.log('Queries: ' + TEST_QUERIES.length);
  console.log('Reps per query: ' + REPS + '\n');

  // Step 1: Open existing index
  console.log('[benchmark] Opening Ford-MYCO index...');
  const cg = await CodeGraph.open(FORD_MYCO_PATH);
  console.log('[benchmark] Index opened successfully\n');

  // Step 2: Start Engram stub
  console.log('[benchmark] Starting Engram stub...');
  const engram = await startEngramStub();
  console.log('[benchmark] Engram stub running at: ' + engram.url + '\n');

  // Step 3: Seed Engram with insights
  console.log('[benchmark] Seeding Engram with Ford-MYCO insights...');
  const handler = new ToolHandler(cg);
  
  process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
  process.env.ENGRAM_URL = engram.url;
  await cg.syncInsightsToEngram();
  console.log('[benchmark] Engram seeded with insights\n');

  // Step 4: Warmup
  console.log('[benchmark] Warming up...');
  for (const { query } of TEST_QUERIES.slice(0, 2)) {
    await handler.execute('codegraph_explore', { query, projectPath: FORD_MYCO_PATH });
    await handler.execute('codegraph_explore_with_memory', { query, projectPath: FORD_MYCO_PATH });
  }
  console.log('[benchmark] Warmup complete\n');

  // Step 5: Measure baseline (without memory)
  console.log('[benchmark] Measuring BASELINE (without Engram memory)...\n');
  const baselineResults = [];
  
  for (const { name, query, description } of TEST_QUERIES) {
    console.log('  Query: ' + name + ' - "' + query + '"');
    const measurements = [];
    
    for (let i = 0; i < REPS; i++) {
      const start = Date.now();
      const result = await handler.execute('codegraph_explore', { query, projectPath: FORD_MYCO_PATH });
      const elapsed = Date.now() - start;
      const text = textOf(result);
      
      measurements.push({
        elapsed_ms: elapsed,
        chars: text.length,
        has_result: text.length > 0,
      });
    }
    
    const med = {
      name: name,
      description: description,
      query: query,
      median_ms: median(measurements.map(m => m.elapsed_ms)),
      median_chars: median(measurements.map(m => m.chars)),
      all_runs: measurements,
    };
    
    baselineResults.push(med);
    console.log('    Median: ' + med.median_ms + 'ms, ' + med.median_chars + ' chars\n');
  }

  // Step 6: Measure with memory
  console.log('[benchmark] Measuring WITH ENGRAM MEMORY...\n');
  const memoryResults = [];
  
  for (const { name, query, description } of TEST_QUERIES) {
    console.log('  Query: ' + name + ' - "' + query + '"');
    const measurements = [];
    
    for (let i = 0; i < REPS; i++) {
      const start = Date.now();
      const result = await handler.execute('codegraph_explore_with_memory', { query, projectPath: FORD_MYCO_PATH });
      const elapsed = Date.now() - start;
      const text = textOf(result);
      
      measurements.push({
        elapsed_ms: elapsed,
        chars: text.length,
        has_memory: text.includes('Project Memory'),
        has_result: text.length > 0,
      });
    }
    
    const med = {
      name: name,
      description: description,
      query: query,
      median_ms: median(measurements.map(m => m.elapsed_ms)),
      median_chars: median(measurements.map(m => m.chars)),
      has_memory: measurements.some(m => m.has_memory),
      all_runs: measurements,
    };
    
    memoryResults.push(med);
    console.log('    Median: ' + med.median_ms + 'ms, ' + med.median_chars + ' chars, hasMemory: ' + med.has_memory + '\n');
  }

  // Step 7: Calculate comparison
  console.log('=== RESULTS ===\n');
  
  const comparison = baselineResults.map((baseline, i) => {
    const memory = memoryResults[i];
    return {
      name: baseline.name,
      description: baseline.description,
      query: baseline.query,
      baseline_ms: baseline.median_ms,
      memory_ms: memory.median_ms,
      overhead_ms: memory.median_ms - baseline.median_ms,
      overhead_pct: ((memory.median_ms - baseline.median_ms) / baseline.median_ms * 100).toFixed(1),
      baseline_chars: baseline.median_chars,
      memory_chars: memory.median_chars,
      chars_diff: memory.median_chars - baseline.median_chars,
      has_memory: memory.has_memory,
    };
  });

  console.log('Query                    | Baseline | With Memory | Overhead | Chars Diff | Has Memory');
  console.log('-------------------------|----------|--------------|----------|------------|------------');
  for (const c of comparison) {
    console.log(
      c.name.padEnd(24) + ' | ' + String(c.baseline_ms).padStart(6) + 'ms | ' + String(c.memory_ms).padStart(10) + 'ms | ' + String(c.overhead_ms).padStart(6) + 'ms (' + c.overhead_pct + '%) | ' + String(c.chars_diff).padStart(8) + ' | ' + c.has_memory
    );
  }

  const avgBaseline = Math.round(baselineResults.reduce((s, r) => s + r.median_ms, 0) / baselineResults.length);
  const avgMemory = Math.round(memoryResults.reduce((s, r) => s + r.median_ms, 0) / memoryResults.length);
  const avgOverhead = Math.round((avgMemory - avgBaseline) / avgBaseline * 100);
  const avgCharsDiff = Math.round(memoryResults.reduce((s, r) => s + r.median_chars, 0) / memoryResults.length - 
                       baselineResults.reduce((s, r) => s + r.median_chars, 0) / baselineResults.length);

  console.log('\n=== SUMMARY ===');
  console.log('Repository: Ford-MYCO');
  console.log('Average baseline latency: ' + avgBaseline + 'ms');
  console.log('Average with memory latency: ' + avgMemory + 'ms');
  console.log('Average overhead: ' + avgOverhead + '%');
  console.log('Average chars difference: ' + (avgCharsDiff > 0 ? '+' : '') + avgCharsDiff);
  console.log('Queries with memory enrichment: ' + memoryResults.filter(r => r.has_memory).length + '/' + memoryResults.length);

  // Step 8: Cleanup
  console.log('\n[benchmark] Cleaning up...');
  await cg.close();
  engram.stop();
  console.log('[benchmark] Cleanup complete');

  // Step 9: Save results
  const output = {
    timestamp: new Date().toISOString(),
    repository: 'Ford-MYCO',
    repository_path: FORD_MYCO_PATH,
    node_version: process.version,
    platform: process.platform,
    queries_tested: TEST_QUERIES.length,
    reps_per_query: REPS,
    comparison: comparison,
    summary: {
      avg_baseline_ms: avgBaseline,
      avg_memory_ms: avgMemory,
      avg_overhead_pct: avgOverhead,
      avg_chars_diff: avgCharsDiff,
      queries_with_memory: memoryResults.filter(r => r.has_memory).length,
      total_queries: memoryResults.length,
    },
  };

  const outputPath = join(process.cwd(), 'benchmark-ford-myco-results.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('\n[benchmark] Results saved to: ' + outputPath);
}

main().catch((err) => {
  console.error('[benchmark] FAILED:', err);
  process.exit(1);
});
