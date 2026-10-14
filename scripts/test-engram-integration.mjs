/**
 * Integration test: CodeGraph → Engram insight sync
 *
 * Tests:
 * 1. Extract insights from indexed repo
 * 2. Sync to Engram stub
 * 3. Search Engram memory
 * 4. Verify deduplication
 *
 * Run: node scripts/test-engram-integration.mjs
 */

import { CodeGraph } from '../dist/index.js';
import { extractInsights, syncInsightsToEngram, searchEngramMemory } from '../dist/integrations/engram-sync.js';

const ENGRAM_URL = process.env.ENGRAM_URL || 'http://127.0.0.1:7437';

async function main() {
  console.log('[test] Opening CodeGraph for D:/codegraph...');
  const cg = await CodeGraph.open('D:/codegraph');

  console.log('[test] Extracting insights...');
  const insights = await extractInsights(cg, {
    maxInsights: 10,
    minCallers: 3,
    minImpact: 5,
    project: 'codegraph',
    includeFlows: true,
  });

  console.log(`[test] Extracted ${insights.length} insights`);
  if (insights.length === 0) {
    console.log('[test] WARN: No insights extracted. Check thresholds.');
  }

  // Show first 3 insights
  for (const insight of insights.slice(0, 3)) {
    console.log(`  - ${insight.title}`);
    console.log(`    confidence: ${insight.confidence.toFixed(2)}, callers: ${insight.callerCount}, impact: ${insight.impactCount}`);
  }

  console.log('\n[test] Syncing to Engram...');
  const syncResult = await syncInsightsToEngram(insights, ENGRAM_URL);
  console.log(`[test] Sync result: ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.failed} failed`);

  console.log('\n[test] Searching Engram memory for "CodeGraph indexAll"...');
  const memory = await searchEngramMemory('CodeGraph indexAll', { limit: 3, project: 'codegraph', engramUrl: ENGRAM_URL });
  console.log(`[test] Found ${memory.length} memory results`);
  for (const m of memory.slice(0, 3)) {
    console.log(`  - ${m.title} (score: ${m.score}, type: ${m.type})`);
  }

  console.log('\n[test] Testing deduplication (sync again)...');
  const syncResult2 = await syncInsightsToEngram(insights, ENGRAM_URL);
  console.log(`[test] Dedup result: ${syncResult2.created} created, ${syncResult2.updated} updated, ${syncResult2.failed} failed`);
  console.log('[test] Expect: totals match (stateless mode counts re-posts as created; server upserts by key, no duplicates)');

  await cg.close();
  console.log('\n[test] Complete!');
}

main().catch(err => {
  console.error('[test] FAILED:', err);
  process.exit(1);
});
