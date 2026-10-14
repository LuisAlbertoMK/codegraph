/**
 * Multi-Project Benchmark: Validates Engram cache benefit across projects
 *
 * Tests 3 projects with different sizes and characteristics:
 * - gentleman-agent-gh (412 observations)
 * - json-convert (240 observations)
 * - opencode (53 observations)
 *
 * Run: node scripts/benchmark-multi-project.mjs
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraph } from '../dist/index.js';
import { ToolHandler } from '../dist/mcp/tools.js';
import { searchEngramMemory } from '../dist/integrations/engram-sync.js';

const PROJECTS = [
  {
    name: 'Ford-MYCO',
    path: 'C:\\Users\\LuisOrozco\\Downloads\\Ford-MYCO',
    projectKey: 'reportes-myco',
    queries: ['reporte', 'reporte German', 'reporte MX'],
  },
  {
    name: 'cosas',
    path: 'C:\\Users\\LuisOrozco\\Downloads\\cosas',
    projectKey: 'cosas',
    queries: ['codegraph', 'benchmark', 'test'],
  },
  {
    name: 'auditorias-backup',
    path: 'C:\\Users\\LuisOrozco\\Downloads\\auditorias-backup',
    projectKey: 'auditorias-backup',
    queries: ['auditoria', 'backup', 'reporte'],
  },
];

const REPS = 3;
const QUERIES_PER_PROJECT = 10;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function textOf(result) {
  const first = result?.content?.[0];
  return (first && first.text) || '';
}

async function main() {
  console.log('=== Multi-Project Benchmark: Cache Benefit Validation ===\n');
  console.log('Projects: ' + PROJECTS.length);
  console.log('Queries per project: ' + QUERIES_PER_PROJECT);
  console.log('Reps: ' + REPS + '\n');

  const allResults = [];

  for (const project of PROJECTS) {
    console.log('--- Project: ' + project.name + ' ---');
    console.log('Path: ' + project.path);
    console.log('Project Key: ' + project.projectKey);
    console.log('Queries: ' + project.queries.join(', '));

    // Check if project exists
    const fs = await import('node:fs');
    if (!fs.existsSync(project.path)) {
      console.log('  SKIP: Project path does not exist\n');
      continue;
    }

    // Open index
    console.log('  Opening index...');
    let cg;
    try {
      cg = await CodeGraph.open(project.path);
    } catch (err) {
      console.log('  SKIP: Could not open index - ' + err.message + '\n');
      continue;
    }
    const handler = new ToolHandler(cg);
    console.log('  Index opened');

    // Warmup (populate cache with first 3 queries)
    console.log('  Warming up...');
    for (const query of project.queries.slice(0, 3)) {
      await handler.execute('codegraph_explore', { query, projectPath: project.path });
      await searchEngramMemory(query, { limit: 3, project: project.projectKey, engramUrl: 'http://localhost:7437' });
    }
    console.log('  Warmup complete');

    // Build session queries (3 new + 7 repeated)
    const sessionQueries = [
      ...project.queries.slice(0, 3).map(q => ({ query: q, type: 'new' })),
      ...Array(7).fill(null).map((_, i) => ({ query: project.queries[i % 3], type: 'repeat' })),
    ];

    // Measure baseline
    console.log('  Measuring baseline...');
    const baselineRuns = [];
    for (let rep = 0; rep < REPS; rep++) {
      const start = Date.now();
      for (const { query } of sessionQueries) {
        await handler.execute('codegraph_explore', { query, projectPath: project.path });
        await searchEngramMemory(query, { limit: 3, project: project.projectKey, engramUrl: 'http://localhost:7437' });
      }
      const elapsed = Date.now() - start;
      baselineRuns.push(elapsed);
    }

    // Measure integrated
    console.log('  Measuring integrated...');
    const integratedRuns = [];
    for (let rep = 0; rep < REPS; rep++) {
      const start = Date.now();
      for (const { query } of sessionQueries) {
        await handler.execute('codegraph_explore_with_memory', { query, projectPath: project.path });
      }
      const elapsed = Date.now() - start;
      integratedRuns.push(elapsed);
    }

    const baselineMedian = median(baselineRuns);
    const integratedMedian = median(integratedRuns);
    const savings = baselineMedian - integratedMedian;
    const savingsPct = ((savings / baselineMedian) * 100).toFixed(1);

    console.log('  Baseline: ' + baselineMedian + 'ms (' + Math.round(baselineMedian / QUERIES_PER_PROJECT) + 'ms/query)');
    console.log('  Integrated: ' + integratedMedian + 'ms (' + Math.round(integratedMedian / QUERIES_PER_PROJECT) + 'ms/query)');
    console.log('  Savings: ' + (savings >= 0 ? '+' : '') + savings + 'ms (' + savingsPct + '%)\n');

    allResults.push({
      project: project.name,
      projectKey: project.projectKey,
      baseline_ms: baselineMedian,
      integrated_ms: integratedMedian,
      savings_ms: savings,
      savings_pct: savingsPct,
      baseline_per_query_ms: Math.round(baselineMedian / QUERIES_PER_PROJECT),
      integrated_per_query_ms: Math.round(integratedMedian / QUERIES_PER_PROJECT),
    });

    await cg.close();
  }

  // Summary
  console.log('=== SUMMARY ===\n');
  console.log('Project                 | Baseline | Integrated | Savings | Baseline/q | Integrated/q');
  console.log('------------------------|----------|------------|---------|------------|-------------');
  for (const r of allResults) {
    console.log(
      r.project.padEnd(23) + ' | ' + String(r.baseline_ms).padStart(6) + 'ms | ' + String(r.integrated_ms).padStart(8) + 'ms | ' + String(r.savings_ms).padStart(5) + 'ms (' + r.savings_pct + '%) | ' + String(r.baseline_per_query_ms).padStart(8) + 'ms | ' + String(r.integrated_per_query_ms).padStart(8) + 'ms'
    );
  }

  const avgSavings = allResults.length > 0
    ? (allResults.reduce((s, r) => s + parseFloat(r.savings_pct), 0) / allResults.length).toFixed(1)
    : 0;
  console.log('\nAverage savings: ' + avgSavings + '%');

  // Save
  const output = {
    timestamp: new Date().toISOString(),
    projects_tested: allResults.length,
    queries_per_project: QUERIES_PER_PROJECT,
    reps: REPS,
    results: allResults,
    average_savings_pct: avgSavings,
  };

  const outputPath = join(process.cwd(), 'benchmark-multi-project-results.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Results saved to: ' + outputPath);
}

main().catch((err) => {
  console.error('[benchmark] FAILED:', err);
  process.exit(1);
});
