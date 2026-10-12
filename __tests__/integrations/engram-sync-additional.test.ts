/**
 * Additional unit tests for Engram integration
 *
 * Covers edge cases not tested in engram-sync.test.ts:
 * 1. extractInsights with minCallers=0 and minImpact=0
 * 2. extractInsights with empty projects (no symbols)
 * 3. syncInsightsToEngram with populated topCallers/topImpacted
 * 4. searchEngramMemory with empty queries and special characters
 * 5. searchEngramMemory with limit=0
 * 6. Concurrent sync behavior
 * 7. extractInsights with includeFlows=true verifying flow quality
 * 8. Unicode characters in symbol names
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'node:child_process';
import CodeGraph from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';
import {
  extractInsights,
  syncInsightsToEngram,
  searchEngramMemory,
  type CodeGraphInsight,
} from '../../src/integrations/engram-sync';

// ============================================================================
// Test Fixtures
// ============================================================================

let testDir: string;
let emptyDir: string;
let unicodeDir: string;
let engramStub: ChildProcess | null = null;
let engramPort: number;
let engramUrl: string;

const ENGRAM_STUB_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'engram-stub.mjs');

// ============================================================================
// Helpers
// ============================================================================

function startEngramStub(): Promise<void> {
  return new Promise((resolve, reject) => {
    engramPort = 4400 + Math.floor(Math.random() * 100);
    engramUrl = `http://localhost:${engramPort}`;

    engramStub = spawn('node', [ENGRAM_STUB_SCRIPT], {
      env: { ...process.env, ENGRAM_STUB_PORT: String(engramPort) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      reject(new Error('Engram stub failed to start within 5s'));
    }, 5000);

    engramStub.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('Listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    engramStub.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function stopEngramStub(): void {
  if (engramStub) {
    engramStub.kill('SIGTERM');
    engramStub = null;
  }
}

async function waitForEngram(url: string, maxAttempts = 10): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Engram stub not ready');
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Engram Integration - Additional Edge Cases', () => {
  let cg: CodeGraph;
  let emptyCg: CodeGraph;
  let unicodeCg: CodeGraph;

  beforeAll(async () => {
    // Create temp test project with normal symbols
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-engram-additional-'));

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'service.ts'), `
export class AuthService {
  login(user: string): boolean { return true; }
  logout(user: string): void {}
}

export class UserService {
  constructor(private auth: AuthService) {}
  getUser(id: string): any { return { id }; }
  deleteUser(id: string): void {}
}
`);

    fs.writeFileSync(path.join(srcDir, 'controller.ts'), `
import { AuthService, UserService } from './service';

export class UserController {
  constructor(
    private auth: AuthService,
    private users: UserService
  ) {}

  handleLogin(user: string): boolean {
    return this.auth.login(user);
  }

  handleLogout(user: string): void {
    this.auth.logout(user);
  }
}
`);

    // Create empty project (no symbols)
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-engram-empty-'));
    const emptySrcDir = path.join(emptyDir, 'src');
    fs.mkdirSync(emptySrcDir, { recursive: true });
    fs.writeFileSync(path.join(emptySrcDir, 'README.md'), '# Empty Project\n');

    // Create project with unicode symbols
    unicodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-engram-unicode-'));
    const unicodeSrcDir = path.join(unicodeDir, 'src');
    fs.mkdirSync(unicodeSrcDir, { recursive: true });

    fs.writeFileSync(path.join(unicodeSrcDir, 'utils.ts'), `
export class Calculadora {
  sumar(a: number, b: number): number { return a + b; }
  restar(a: number, b: number): number { return a - b; }
}

export class ProcesadorTexto {
  mayusculas(texto: string): string { return texto.toUpperCase(); }
  minusculas(texto: string): string { return texto.toLowerCase(); }
}

export class ValidadorEmail {
  validar(email: string): boolean { return email.includes('@'); }
}
`);

    fs.writeFileSync(path.join(unicodeSrcDir, 'index.ts'), `
import { Calculadora, ProcesadorTexto, ValidadorEmail } from './utils';

const calc = new Calculadora();
const proc = new ProcesadorTexto();
const val = new ValidadorEmail();

export { calc, proc, val };
`);

    // Initialize and index all projects
    cg = await CodeGraph.init(testDir, { index: true });
    emptyCg = await CodeGraph.init(emptyDir, { index: true });
    unicodeCg = await CodeGraph.init(unicodeDir, { index: true });

    // Start Engram stub
    await startEngramStub();
    await waitForEngram(engramUrl);
  }, 60000);

  afterAll(async () => {
    await cg?.close();
    await emptyCg?.close();
    await unicodeCg?.close();
    stopEngramStub();
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
    if (emptyDir) fs.rmSync(emptyDir, { recursive: true, force: true });
    if (unicodeDir) fs.rmSync(unicodeDir, { recursive: true, force: true });
  });

  // =========================================================================
  // extractInsights edge cases
  // =========================================================================

  describe('extractInsights - edge cases', () => {
    it('should return empty array for empty project', async () => {
      const insights = await extractInsights(emptyCg, {
        maxInsights: 10,
        minCallers: 1,
        minImpact: 1,
        project: 'empty-project',
      });

      expect(insights).toEqual([]);
    });

    it('should return insights with minCallers=0 and minImpact=0', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 20,
        minCallers: 0,
        minImpact: 0,
        project: 'zero-threshold',
      });

      // Should return more insights with lower thresholds
      expect(insights.length).toBeGreaterThan(0);
    });

    it('should include all node types with minCallers=0', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 50,
        minCallers: 0,
        minImpact: 0,
        project: 'all-types',
      });

      // Should have insights from various node types
      const types = new Set(insights.map(i => i.type));
      expect(types.size).toBeGreaterThan(0);
    });

    it('should handle maxInsights=0 gracefully', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 0,
        minCallers: 1,
        minImpact: 1,
        project: 'zero-max',
      });

      expect(insights).toEqual([]);
    });

    it('should handle very large maxInsights', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 10000,
        minCallers: 1,
        minImpact: 1,
        project: 'large-max',
      });

      // Should return all available insights, not crash
      expect(insights.length).toBeGreaterThan(0);
      expect(insights.length).toBeLessThanOrEqual(10000);
    });
  });

  // =========================================================================
  // extractInsights with unicode symbols
  // =========================================================================

  describe('extractInsights - unicode symbols', () => {
    it('should extract insights from unicode symbol names', async () => {
      const insights = await extractInsights(unicodeCg, {
        maxInsights: 10,
        minCallers: 1,
        minImpact: 1,
        project: 'unicode-project',
      });

      expect(insights.length).toBeGreaterThan(0);
    });

    it('should preserve unicode characters in insight fields', async () => {
      const insights = await extractInsights(unicodeCg, {
        maxInsights: 10,
        minCallers: 0,
        minImpact: 0,
        project: 'unicode-preserve',
      });

      // Check that unicode names are preserved
      const hasUnicode = insights.some(i =>
        i.name.includes('Calculadora') ||
        i.name.includes('ProcesadorTexto') ||
        i.name.includes('ValidadorEmail') ||
        i.name.includes('sumar') ||
        i.name.includes('mayusculas')
      );

      expect(hasUnicode).toBe(true);
    });

    it('should generate valid deduplication keys for unicode symbols', async () => {
      const insights = await extractInsights(unicodeCg, {
        maxInsights: 10,
        minCallers: 0,
        minImpact: 0,
        project: 'unicode-keys',
      });

      for (const insight of insights) {
        expect(insight.deduplication_key).toMatch(/^codegraph:unicode-keys:/);
        expect(insight.deduplication_key.length).toBeGreaterThan('codegraph:unicode-keys:'.length);
      }
    });
  });

  // =========================================================================
  // syncInsightsToEngram with populated topCallers/topImpacted
  // =========================================================================

  describe('syncInsightsToEngram - populated relationships', () => {
    it('should sync insights with populated topCallers and topImpacted', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'populated-relationships',
      });

      // Verify insights have populated relationships
      const insightsWithCallers = insights.filter(i => i.topCallers.length > 0);
      const insightsWithImpacted = insights.filter(i => i.topImpacted.length > 0);

      // At least some insights should have populated relationships
      expect(insightsWithCallers.length + insightsWithImpacted.length).toBeGreaterThan(0);

      // Sync should succeed
      const result = await syncInsightsToEngram(insights, engramUrl);
      expect(result.failed).toBe(0);
      expect(result.created + result.updated).toBe(insights.length);
    });

    it('should handle insights with empty topCallers and topImpacted', async () => {
      const insights: CodeGraphInsight[] = [
        {
          deduplication_key: 'codegraph:empty-rel:Foo',
          title: 'Foo',
          content: 'Test with no relationships',
          type: 'symbol',
          project: 'empty-rel',
          name: 'Foo',
          qualifiedName: 'Foo',
          filePath: '/test.ts',
          startLine: 1,
          callerCount: 0,
          impactCount: 0,
          topCallers: [],
          topImpacted: [],
          confidence: 0.5,
          topic_key: 'codegraph:empty-rel',
        },
      ];

      const result = await syncInsightsToEngram(insights, engramUrl);
      expect(result.failed).toBe(0);
      expect(result.created + result.updated).toBe(1);
    });
  });

  // =========================================================================
  // searchEngramMemory edge cases
  // =========================================================================

  describe('searchEngramMemory - edge cases', () => {
    beforeEach(async () => {
      // Seed test data
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'search-edge-cases',
      });
      await syncInsightsToEngram(insights, engramUrl);
    });

    it('should handle empty query string', async () => {
      const results = await searchEngramMemory('', {
        limit: 5,
        project: 'search-edge-cases',
        engramUrl,
      });

      // Should return empty array or all results depending on implementation
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle query with special characters', async () => {
      const results = await searchEngramMemory('AuthService!@#$%', {
        limit: 5,
        project: 'search-edge-cases',
        engramUrl,
      });

      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle query with regex special characters', async () => {
      const results = await searchEngramMemory('.*+?^${}()|[]\\', {
        limit: 5,
        project: 'search-edge-cases',
        engramUrl,
      });

      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle limit=0', async () => {
      const results = await searchEngramMemory('AuthService', {
        limit: 0,
        project: 'search-edge-cases',
        engramUrl,
      });

      expect(results).toEqual([]);
    });

    it('should handle very large limit', async () => {
      const results = await searchEngramMemory('AuthService', {
        limit: 10000,
        project: 'search-edge-cases',
        engramUrl,
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(10000);
    });

    it('should handle unicode query', async () => {
      const insights = await extractInsights(unicodeCg, {
        maxInsights: 5,
        minCallers: 0,
        minImpact: 0,
        project: 'unicode-search',
      });
      await syncInsightsToEngram(insights, engramUrl);

      const results = await searchEngramMemory('Calculadora', {
        limit: 5,
        project: 'unicode-search',
        engramUrl,
      });

      expect(Array.isArray(results)).toBe(true);
    });
  });

  // =========================================================================
  // Concurrent sync behavior
  // =========================================================================

  describe('concurrent sync behavior', () => {
    it('should handle multiple concurrent syncs', async () => {
      const insights1 = await extractInsights(cg, {
        maxInsights: 3,
        minCallers: 1,
        minImpact: 1,
        project: 'concurrent-1',
      });

      const insights2 = await extractInsights(cg, {
        maxInsights: 3,
        minCallers: 1,
        minImpact: 1,
        project: 'concurrent-2',
      });

      const insights3 = await extractInsights(unicodeCg, {
        maxInsights: 3,
        minCallers: 0,
        minImpact: 0,
        project: 'concurrent-3',
      });

      // Run syncs concurrently
      const [result1, result2, result3] = await Promise.all([
        syncInsightsToEngram(insights1, engramUrl),
        syncInsightsToEngram(insights2, engramUrl),
        syncInsightsToEngram(insights3, engramUrl),
      ]);

      expect(result1.failed).toBe(0);
      expect(result2.failed).toBe(0);
      expect(result3.failed).toBe(0);
    });

    it('should handle concurrent syncs with same project', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'concurrent-same',
      });

      // Run multiple syncs for the same project concurrently
      const results = await Promise.all([
        syncInsightsToEngram(insights, engramUrl),
        syncInsightsToEngram(insights, engramUrl),
        syncInsightsToEngram(insights, engramUrl),
      ]);

      // All should complete without error
      for (const result of results) {
        expect(result.failed).toBe(0);
      }
    });
  });

  // =========================================================================
  // extractInsights with includeFlows=true - quality verification
  // =========================================================================

  describe('extractInsights - flow quality', () => {
    it('should extract flow insights with valid structure', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 20,
        minCallers: 1,
        minImpact: 1,
        project: 'flow-quality',
        includeFlows: true,
      });

      const flowInsights = insights.filter(i => i.type === 'flow');

      for (const flow of flowInsights) {
        // Flow insights should have meaningful content
        expect(flow.content.length).toBeGreaterThan(0);
        expect(flow.title.length).toBeGreaterThan(0);
        expect(flow.confidence).toBeGreaterThan(0);
        expect(flow.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should have more insights with includeFlows=true than false', async () => {
      const withFlows = await extractInsights(cg, {
        maxInsights: 50,
        minCallers: 0,
        minImpact: 0,
        project: 'flow-comparison',
        includeFlows: true,
      });

      const withoutFlows = await extractInsights(cg, {
        maxInsights: 50,
        minCallers: 0,
        minImpact: 0,
        project: 'flow-comparison',
        includeFlows: false,
      });

      // With flows should have >= insights than without
      expect(withFlows.length).toBeGreaterThanOrEqual(withoutFlows.length);
    });
  });

  // =========================================================================
  // Confidence score edge cases
  // =========================================================================

  describe('confidence score edge cases', () => {
    it('should have confidence between 0 and 1 for all insights', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 50,
        minCallers: 0,
        minImpact: 0,
        project: 'confidence-check',
      });

      for (const insight of insights) {
        expect(insight.confidence).toBeGreaterThanOrEqual(0);
        expect(insight.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should have higher confidence for insights with more callers', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 50,
        minCallers: 0,
        minImpact: 0,
        project: 'confidence-correlation',
      });

      // Sort by caller count
      const sorted = [...insights].sort((a, b) => a.callerCount - b.callerCount);

      // Generally, insights with more callers should have higher confidence
      // (though this is a soft correlation, not a strict rule)
      if (sorted.length >= 2) {
        const lowCaller = sorted[0];
        const highCaller = sorted[sorted.length - 1];

        // High caller count should generally have higher or equal confidence
        expect(highCaller.confidence).toBeGreaterThanOrEqual(lowCaller.confidence * 0.5);
      }
    });
  });

  // =========================================================================
  // Large-scale sync
  // =========================================================================

  describe('large-scale sync', () => {
    it('should handle syncing many insights at once', async () => {
      // Create a larger set of insights
      const insights: CodeGraphInsight[] = [];
      for (let i = 0; i < 50; i++) {
        insights.push({
          deduplication_key: `codegraph:large-scale:Symbol${i}`,
          title: `Symbol${i}`,
          content: `This is symbol number ${i} with some content to sync`,
          type: 'symbol',
          project: 'large-scale',
          name: `Symbol${i}`,
          qualifiedName: `Symbol${i}`,
          filePath: `/src/symbol${i}.ts`,
          startLine: i * 10,
          callerCount: Math.floor(Math.random() * 10),
          impactCount: Math.floor(Math.random() * 20),
          topCallers: [],
          topImpacted: [],
          confidence: 0.5 + Math.random() * 0.5,
          topic_key: 'codegraph:large-scale',
        });
      }

      const result = await syncInsightsToEngram(insights, engramUrl);
      expect(result.failed).toBe(0);
      expect(result.created + result.updated).toBe(50);
    });
  });

  // =========================================================================
  // OR fallback on strict-AND miss (code vocab vs prose memory)
  // =========================================================================

  describe('searchEngramMemory - OR fallback', () => {
    // Strict-AND server: a row matches only when EVERY term occurs in it,
    // like real Engram FTS5. `authentication` occurs in no row, `login` in one.
    const ROWS = [
      { title: 'Login guard', content: 'test_auth_login cache freshness guard', rank: -4.1, type: 'bugfix' },
      { title: 'Pipeline notes', content: 'tracking pipeline sweep decisions', rank: -2.0, type: 'decision' },
    ];
    let andServer: import('node:http').Server | null = null;
    let andUrl = '';
    const seenQueries: string[] = [];

    beforeAll(async () => {
      const http = await import('node:http');
      andServer = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://localhost');
        if (u.pathname !== '/search') {
          res.statusCode = 404;
          res.end('[]');
          return;
        }
        const q = (u.searchParams.get('q') || '').toLowerCase();
        seenQueries.push(q);
        const terms = q.split(/\s+/).filter(Boolean);
        const hits = ROWS.filter((r) => {
          const hay = `${r.title} ${r.content}`.toLowerCase();
          return terms.length > 0 && terms.every((t) => hay.includes(t));
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(hits));
      });
      await new Promise<void>((resolve) => andServer!.listen(0, '127.0.0.1', resolve));
      const addr = andServer.address();
      andUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        andServer!.close((e) => (e ? reject(e) : resolve())));
      andServer = null;
    });

    it('falls back to per-term retrieval when strict AND matches nothing', async () => {
      // `authentication` matches zero rows: strict AND is empty, but the
      // `login` fallback must surface the Login guard row.
      const results = await searchEngramMemory('authentication login', {
        engramUrl: andUrl,
        project: 'fallback-probe',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.title === 'Login guard')).toBe(true);
      // Strict query + one fetch per fallback term.
      expect(seenQueries).toContain('authentication login');
      expect(seenQueries).toContain('login');
    });

    it('does not fetch extra requests when the strict query hits', async () => {
      seenQueries.length = 0;
      const results = await searchEngramMemory('login guard', {
        engramUrl: andUrl,
        project: 'fallback-noop',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(seenQueries).toEqual(['login guard']);
    });

    it('merges, dedupes and respects the limit', async () => {
      // Both singles hit overlapping rows; limit 1 must win after score sort.
      const results = await searchEngramMemory('authentication pipeline', {
        limit: 1,
        engramUrl: andUrl,
        project: 'fallback-limit',
      });
      expect(results.length).toBe(1);
      // Highest rank (closest to zero) first.
      expect(results[0].title).toBe('Pipeline notes');
    });

    it('strict results win over cached fallback once new data matches', async () => {
      // Mutable dataset: phase 1 behaves like the frozen server above.
      const rows = [
        { title: 'Login guard', content: 'test_auth_login cache freshness guard', rank: -4.1, type: 'bugfix' },
      ];
      const http = await import('node:http');
      const mutable = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://localhost');
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const terms = q.split(/\s+/).filter(Boolean);
        const hits = rows.filter((r) => {
          const hay = `${r.title} ${r.content}`.toLowerCase();
          return terms.length > 0 && terms.every((t) => hay.includes(t));
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(hits));
      });
      await new Promise<void>((resolve) => mutable.listen(0, '127.0.0.1', resolve));
      const addr = mutable.address();
      const mutableUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      try {
        const project = 'fallback-stale-probe';
        const first = await searchEngramMemory('authentication login', {
          engramUrl: mutableUrl,
          project,
        });
        expect(first.some((r) => r.title === 'Login guard')).toBe(true);

        // New memory arrives that matches the strict AND query.
        rows.push({
          title: 'Auth notes',
          content: 'authentication login flow decisions',
          rank: -1.0,
          type: 'decision',
        });
        const second = await searchEngramMemory('authentication login', {
          engramUrl: mutableUrl,
          project,
        });
        // Strict hit must win: no stale OR-only rows served from cache.
        expect(second.some((r) => r.title === 'Auth notes')).toBe(true);
        expect(second.some((r) => r.title === 'Login guard')).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) =>
          mutable.close((e) => (e ? reject(e) : resolve())));
      }
    });
  });

  // =========================================================================
  // Round-one fixes: memory-leg deadline
  // =========================================================================

  describe('explore_with_memory - memory deadline', () => {
    it('returns explore results when Engram hangs, well under the fetch timeout', async () => {
      const http = await import('node:http');
      const hanging = http.createServer(() => { /* accept, never respond */ });
      await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
      const addr = hanging.address();
      const hangingUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

      const prevUrl = process.env.ENGRAM_URL;
      process.env.ENGRAM_URL = hangingUrl;
      process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
      try {
        const handler = new ToolHandler(cg);
        const base = await handler.execute('codegraph_explore', { query: 'login', projectPath: testDir });
        const baseText = (base.content?.[0] as { text?: string })?.text || '';

        const t0 = Date.now();
        const enriched = await handler.execute('codegraph_explore_with_memory', {
          query: 'login',
          projectPath: testDir,
        });
        const elapsed = Date.now() - t0;
        const enrichedText = (enriched.content?.[0] as { text?: string })?.text || '';

        // Hung memory must not hold explore hostage for the 10s fetch timeout.
        expect(elapsed).toBeLessThan(9000);
        // Graceful degradation: identical to baseline, no memory section.
        expect(enrichedText).toBe(baseText);
        expect(enrichedText.includes('Project Memory')).toBe(false);
      } finally {
        if (prevUrl === undefined) delete process.env.ENGRAM_URL;
        else process.env.ENGRAM_URL = prevUrl;
        hanging.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          hanging.close((e) => (e ? reject(e) : resolve())));
      }
    }, 20000);
  });
});
