/**
 * Insight selection limits: defaults, env overrides, and proof that a limit
 * actually changes what gets extracted (so the env vars are wired, not inert).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/index';
import {
  DEFAULT_INSIGHT_LIMITS,
  extractInsights,
  readInsightLimitsFromEnv,
} from '../../src/integrations/engram-sync';

describe('readInsightLimitsFromEnv', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(readInsightLimitsFromEnv({})).toEqual({ maxInsights: 30, minCallers: 3, minImpact: 5 });
    expect(DEFAULT_INSIGHT_LIMITS).toEqual({ maxInsights: 30, minCallers: 3, minImpact: 5 });
  });

  it('reads all three overrides', () => {
    expect(readInsightLimitsFromEnv({
      CODEGRAPH_ENGRAM_MAX_INSIGHTS: '10',
      CODEGRAPH_ENGRAM_MIN_CALLERS: '7',
      CODEGRAPH_ENGRAM_MIN_IMPACT: '12',
    })).toEqual({ maxInsights: 10, minCallers: 7, minImpact: 12 });
  });

  it('allows a zero threshold but never a zero insight count', () => {
    const limits = readInsightLimitsFromEnv({
      CODEGRAPH_ENGRAM_MAX_INSIGHTS: '0',
      CODEGRAPH_ENGRAM_MIN_CALLERS: '0',
      CODEGRAPH_ENGRAM_MIN_IMPACT: '0',
    });
    expect(limits.maxInsights).toBe(30);
    expect(limits.minCallers).toBe(0);
    expect(limits.minImpact).toBe(0);
  });

  it('falls back per value on junk rather than throwing', () => {
    expect(readInsightLimitsFromEnv({
      CODEGRAPH_ENGRAM_MAX_INSIGHTS: 'lots',
      CODEGRAPH_ENGRAM_MIN_CALLERS: '2.5',
      CODEGRAPH_ENGRAM_MIN_IMPACT: '   ',
    })).toEqual({ maxInsights: 30, minCallers: 3, minImpact: 5 });
    expect(readInsightLimitsFromEnv({ CODEGRAPH_ENGRAM_MIN_CALLERS: '-1' }).minCallers).toBe(3);
  });

  it('clamps maxInsights so a typo cannot turn a sync into a graph scan', () => {
    expect(readInsightLimitsFromEnv({ CODEGRAPH_ENGRAM_MAX_INSIGHTS: '999999' }).maxInsights).toBe(200);
  });
});

describe('insight limits drive extraction', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-limits-test-'));
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'core.ts'), 'export function core() { return 1; }\n');
    for (const n of ['a1', 'a2', 'a3', 'a4']) {
      fs.writeFileSync(path.join(src, `${n}.ts`),
        `import { core } from './core';\nexport function ${n}() { return core(); }\n`);
    }
    fs.writeFileSync(path.join(src, 'top.ts'),
      `import { a1 } from './a1';\nexport function top() { return a1(); }\n`);
    cg = await CodeGraph.init(root, { index: true });
  }, 30000);

  afterAll(async () => {
    await cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.CODEGRAPH_ENGRAM_MIN_CALLERS;
    delete process.env.CODEGRAPH_ENGRAM_MIN_IMPACT;
    delete process.env.CODEGRAPH_ENGRAM_MAX_INSIGHTS;
  });

  it('raises the bar when the environment asks for it', async () => {
    const defaultRun = await extractInsights(cg, { project: 'limits' });
    expect(defaultRun.length).toBeGreaterThan(0);

    process.env.CODEGRAPH_ENGRAM_MIN_CALLERS = '99';
    const strictRun = await extractInsights(cg, { ...readInsightLimitsFromEnv(), project: 'limits' });
    expect(strictRun).toEqual([]);
  });

  it('never returns more than maxInsights', async () => {
    process.env.CODEGRAPH_ENGRAM_MIN_CALLERS = '1';
    process.env.CODEGRAPH_ENGRAM_MIN_IMPACT = '1';
    process.env.CODEGRAPH_ENGRAM_MAX_INSIGHTS = '2';
    const insights = await extractInsights(cg, { ...readInsightLimitsFromEnv(), project: 'limits' });
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.length).toBeLessThanOrEqual(2);
  });
});
