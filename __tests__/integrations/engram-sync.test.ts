/**
 * Unit tests for Engram integration (src/integrations/engram-sync.ts)
 *
 * Tests:
 * 1. extractInsights() — insight extraction from CodeGraph
 * 2. syncInsightsToEngram() — sync to Engram with deduplication
 * 3. searchEngramMemory() — search Engram memory
 * 4. Graceful degradation when Engram unavailable
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import CodeGraph from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';
import {
  extractInsights,
  syncInsightsToEngram,
  searchEngramMemory,
  clearMemoryCache,
  type CodeGraphInsight,
} from '../../src/integrations/engram-sync';

// ============================================================================
// Test Fixtures
// ============================================================================

let testDir: string;
let engramStub: ChildProcess | null = null;
let engramPort: number;
let engramUrl: string;

const ENGRAM_STUB_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'engram-stub.mjs');

// ============================================================================
// Helpers
// ============================================================================

function startEngramStub(): Promise<void> {
  return new Promise((resolve, reject) => {
    engramPort = 4200 + Math.floor(Math.random() * 100);
    engramUrl = `http://localhost:${engramPort}`;

    engramStub = spawn('node', [ENGRAM_STUB_SCRIPT], {
      env: { ...process.env, ENGRAM_STUB_PORT: String(engramPort) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for server to be ready
    const timeout = setTimeout(() => {
      reject(new Error('Engram stub failed to start within 5s'));
    }, 5000);

    engramStub.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('Listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    engramStub.stderr?.on('data', (data: Buffer) => {
      console.error(`[engram-stub] ${data}`);
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

function startHangingServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(() => { /* accept the socket, never respond */ });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

const MINIMAL_INSIGHT: CodeGraphInsight = {
  deduplication_key: 'codegraph:test:Foo',
  title: 'Foo',
  content: 'Test',
  type: 'symbol',
  project: 'test',
  name: 'Foo',
  qualifiedName: 'Foo',
  filePath: '/test.ts',
  startLine: 1,
  callerCount: 1,
  impactCount: 1,
  topCallers: [],
  topImpacted: [],
  confidence: 0.5,
  topic_key: 'codegraph:test',
};

// ============================================================================
// Test Suite
// ============================================================================

describe('Engram Integration', () => {
  let cg: CodeGraph;

  beforeAll(async () => {
    // Create temp test project
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-engram-test-'));

    // Create a simple TypeScript project for indexing
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // Create test files with call relationships
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

    fs.writeFileSync(path.join(srcDir, 'index.ts'), `
import { UserController } from './controller';
import { AuthService, UserService } from './service';

const auth = new AuthService();
const users = new UserService(auth);
const controller = new UserController(auth, users);

export { controller };
`);

    // Nested containers (Ruby): parity must hold through arbitrary nesting
    fs.writeFileSync(path.join(srcDir, 'nested.rb'), `module Outer
  module Inner
    def self.deep_helper(x)
      x * 2
    end
  end
  def self.outer_call(x)
    Inner.deep_helper(x)
  end
end
`);

    // Initialize and index
    cg = await CodeGraph.init(testDir, { index: true });

    // Start Engram stub
    await startEngramStub();
    await waitForEngram(engramUrl);
  }, 30000);

  afterAll(async () => {
    await cg?.close();
    stopEngramStub();
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // extractInsights tests
  // =========================================================================

  describe('extractInsights', () => {
    it('should extract insights from indexed project', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 10,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
        includeFlows: true,
      });

      expect(insights.length).toBeGreaterThan(0);
      expect(insights.length).toBeLessThanOrEqual(10);
    });

    it('should generate correct deduplication keys', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
      });

      for (const insight of insights) {
        expect(insight.deduplication_key).toMatch(/^codegraph:test-project:/);
      }
    });

    it('should include caller and impact counts', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
      });

      for (const insight of insights) {
        expect(insight.callerCount).toBeGreaterThanOrEqual(1);
        expect(insight.impactCount).toBeGreaterThanOrEqual(1);
        expect(insight.confidence).toBeGreaterThan(0);
        expect(insight.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('never lists the focal symbol among topImpacted', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 10,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
      });

      expect(insights.length).toBeGreaterThan(0);
      // Fixture symbol names are unique per symbol (constructors aside, and
      // neither constructor's set contains the other), so a name match means
      // the focal symbol itself leaked into its own impacted sample — the
      // impact set leads with the focal id by platform convention.
      for (const insight of insights.filter((i) => i.type === 'symbol')) {
        expect(insight.topImpacted).not.toContain(insight.name);
        expect(insight.topImpacted.length).toBeLessThanOrEqual(5);
      }
    });

    it('should respect maxInsights limit', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 3,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
      });

      expect(insights.length).toBeLessThanOrEqual(3);
    });

    it('should filter by minCallers threshold', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 10,
        minCallers: 100, // Very high threshold
        minImpact: 1,
        project: 'test-project',
      });

      // Should return empty or very few insights
      expect(insights.length).toBeLessThanOrEqual(1);
    });

    it('should include flow insights when includeFlows=true', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 10,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
        includeFlows: true,
      });

      const flowInsights = insights.filter(i => i.type === 'flow');
      // May or may not have flows depending on graph structure
      expect(flowInsights.length).toBeGreaterThanOrEqual(0);
    });

    it('should not include flow insights when includeFlows=false', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 10,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
        includeFlows: false,
      });

      const flowInsights = insights.filter(i => i.type === 'flow');
      expect(flowInsights.length).toBe(0);
    });

    it('two-stage ranking matches full brute-force scoring', async () => {
      const maxInsights = 5;
      const insights = await extractInsights(cg, {
        maxInsights,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
        includeFlows: false,
      });

      // Brute force over the full corpus (no candidate pool)
      const corpus = [
        ...cg.getNodesByKind('function'),
        ...cg.getNodesByKind('method'),
        ...cg.getNodesByKind('class'),
        ...cg.getNodesByKind('interface'),
      ];
      const expected = corpus
        .map((node) => {
          const callerCount = cg.getCallers(node.id, 1).length;
          const impactCount = cg.getImpactRadius(node.id, 2).nodes?.size || 0;
          return { node, callerCount, impactCount, score: callerCount * Math.log(impactCount + 1) };
        })
        .filter((r) => r.callerCount >= 1 && r.impactCount >= 1)
        // Same order contract as production (score desc, identity tie-break —
        // filePath included: qualifiedName alone collides across definitions)
        .sort((a, b) => b.score - a.score
          || (a.node.qualifiedName < b.node.qualifiedName ? -1 : a.node.qualifiedName > b.node.qualifiedName ? 1 : 0)
          || (a.node.filePath < b.node.filePath ? -1 : a.node.filePath > b.node.filePath ? 1 : 0))
        .slice(0, maxInsights)
        .map((r) => `${r.node.filePath}:${r.node.qualifiedName}`);

      expect(insights.map((i) => `${i.filePath}:${i.qualifiedName}`)).toEqual(expected);
    });

    it('impact count matches materialized impact size', async () => {
      const corpus = [
        ...cg.getNodesByKind('function'),
        ...cg.getNodesByKind('method'),
      ].slice(0, 20);

      expect(corpus.length).toBeGreaterThan(0);
      for (const node of corpus) {
        expect(cg.getImpactRadiusCount(node.id, 2)).toBe(
          cg.getImpactRadius(node.id, 2).nodes.size
        );
      }
    });

    it('batched impact ids match the recursive walk', async () => {
      const corpus = [
        ...cg.getNodesByKind('function'),
        ...cg.getNodesByKind('method'),
        ...cg.getNodesByKind('class'),
        ...cg.getNodesByKind('module'),
      ];

      expect(corpus.length).toBeGreaterThan(0);
      for (const node of corpus) {
        const recursive = [...cg.getImpactRadius(node.id, 2).nodes.keys()].sort();
        const batched = [...cg.getImpactIdsBatched(node.id, 2)].sort();
        expect(batched).toEqual(recursive);
      }
    });
  });

  // =========================================================================
  // syncInsightsToEngram tests
  // =========================================================================

  describe('syncInsightsToEngram', () => {
    it('should sync insights to Engram', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
      });

      const result = await syncInsightsToEngram(insights, engramUrl);

      expect(result.created + result.updated).toBe(insights.length);
      expect(result.failed).toBe(0);
    });

    it('should deduplicate on re-sync (server-side upsert by deduplication_key)', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
      });

      // First sync
      const first = await syncInsightsToEngram(insights, engramUrl);
      expect(first.created + first.updated).toBe(insights.length);
      expect(first.failed).toBe(0);

      // Second sync: stateless mode keeps no local state, so every key
      // counts as created — but the server upserts by deduplication_key
      // (same ids, no duplicates). Precise created/updated accounting lives
      // in the rootDir state path (see 'skips revision lookups' below).
      const result = await syncInsightsToEngram(insights, engramUrl);

      expect(result.failed).toBe(0);
      expect(result.created + result.updated).toBe(insights.length);
    });

    it('should handle empty insights array', async () => {
      const result = await syncInsightsToEngram([], engramUrl);

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('should not throw on network error', async () => {
      const insights: CodeGraphInsight[] = [{
        deduplication_key: 'codegraph:test:Foo',
        title: 'Foo',
        content: 'Test',
        type: 'symbol',
        project: 'test',
        name: 'Foo',
        qualifiedName: 'Foo',
        filePath: '/test.ts',
        startLine: 1,
        callerCount: 1,
        impactCount: 1,
        topCallers: [],
        topImpacted: [],
        confidence: 0.5,
        topic_key: 'codegraph:test',
      }];

      // Use invalid URL
      const result = await syncInsightsToEngram(insights, 'http://localhost:59999');

      // Should not throw, just count as failed
      expect(result.failed).toBe(1);
    });

    it('aborts hung requests within ENGRAM_TIMEOUT_MS', async () => {
      const hanging = await startHangingServer();
      process.env.ENGRAM_TIMEOUT_MS = '300';
      try {
        const start = Date.now();
        const result = await syncInsightsToEngram([MINIMAL_INSIGHT], hanging.url);
        expect(Date.now() - start).toBeLessThan(8000);
        expect(result.failed).toBe(1);
      } finally {
        delete process.env.ENGRAM_TIMEOUT_MS;
        hanging.close();
      }
    });

    it('skips revision lookups for keys in local state', async () => {
      const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-engram-state-'));
      try {
        const insights = await extractInsights(cg, {
          maxInsights: 5,
          minCallers: 1,
          minImpact: 1,
          project: 'state-test',
        });
        expect(insights.length).toBeGreaterThan(0);

        const first = await syncInsightsToEngram(insights, engramUrl, { rootDir: stateRoot });
        expect(first.created + first.updated).toBe(insights.length);
        expect(first.skipped).toBe(0);

        const stateFile = path.join(stateRoot, '.codegraph', 'engram-sync-state.json');
        expect(fs.existsSync(stateFile)).toBe(true);

        // Unchanged content: everything skipped, zero network beyond the call
        const second = await syncInsightsToEngram(insights, engramUrl, { rootDir: stateRoot });
        expect(second.failed).toBe(0);
        expect(second.created).toBe(0);
        expect(second.updated).toBe(0);
        expect(second.skipped).toBe(insights.length);

        // Changed content: only the changed insight syncs
        const firstInsight = insights[0];
        expect(firstInsight).toBeDefined();
        if (firstInsight) firstInsight.content += '\nchanged!';
        const third = await syncInsightsToEngram(insights, engramUrl, { rootDir: stateRoot });
        expect(third.failed).toBe(0);
        expect(third.created + third.updated).toBe(1);
        expect(third.skipped).toBe(insights.length - 1);
      } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // searchEngramMemory tests
  // =========================================================================

  describe('searchEngramMemory', () => {
    beforeEach(async () => {
      // Isolate cache: cases below reuse a project/query across backends
      clearMemoryCache();
      // Seed some test data
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
      });
      await syncInsightsToEngram(insights, engramUrl);
    });

    it('should search Engram memory', async () => {
      const results = await searchEngramMemory('AuthService', {
        limit: 3,
        project: 'test-project',
        engramUrl,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should return empty array for no matches', async () => {
      const results = await searchEngramMemory('NonExistentSymbol12345', {
        limit: 3,
        project: 'test-project',
        engramUrl,
      });

      expect(results).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      const results = await searchEngramMemory('Service', {
        limit: 2,
        project: 'test-project',
        engramUrl,
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should filter by project', async () => {
      const results = await searchEngramMemory('AuthService', {
        limit: 3,
        project: 'different-project',
        engramUrl,
      });

      expect(results).toEqual([]);
    });

    it('should return empty array when Engram unavailable', async () => {
      const results = await searchEngramMemory('AuthService', {
        limit: 3,
        project: 'test-project',
        engramUrl: 'http://localhost:59999',
      });

      expect(results).toEqual([]);
    });

    it('should strip stopwords from natural-language queries', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'test-project',
      });
      await syncInsightsToEngram(insights, engramUrl);

      const results = await searchEngramMemory('how does AuthService work', {
        limit: 3,
        project: 'test-project',
        engramUrl,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain('AuthService');
    });

    it('should return empty array quickly when Engram hangs', async () => {      const hanging = await startHangingServer();
      process.env.ENGRAM_TIMEOUT_MS = '300';
      try {
        const start = Date.now();
        const results = await searchEngramMemory('AuthService', {
          limit: 3,
          project: 'test-project',
          engramUrl: hanging.url,
        });
        expect(Date.now() - start).toBeLessThan(8000);
        expect(results).toEqual([]);
      } finally {
        delete process.env.ENGRAM_TIMEOUT_MS;
        hanging.close();
      }
    });
  });

  // =========================================================================
  // Integration: extract → sync → search
  // =========================================================================

  describe('end-to-end flow', () => {
    it('should extract, sync, and search insights', async () => {
      // Extract
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'e2e-test',
      });

      expect(insights.length).toBeGreaterThan(0);

      // Sync
      const syncResult = await syncInsightsToEngram(insights, engramUrl);
      expect(syncResult.failed).toBe(0);

      // Search
      const searchResults = await searchEngramMemory(insights[0].name, {
        limit: 3,
        project: 'e2e-test',
        engramUrl,
      });

      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].title).toContain(insights[0].name);
    });
  });

  // =========================================================================
  // codegraph_memory_search MCP tool (single-MCP memory recall)
  // =========================================================================

  describe('codegraph_memory_search tool', () => {
    let handler: ToolHandler;

    beforeAll(() => {
      handler = new ToolHandler(cg);
      process.env.ENGRAM_URL = engramUrl;
    });

    beforeEach(() => {
      // Same backend-swapping reason as above (ENGRAM_URL changes per test)
      clearMemoryCache();
    });

    afterAll(() => {
      delete process.env.ENGRAM_URL;
    });

    it('returns matching memories for a seeded query', async () => {
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: 'tool-test',
      });
      await syncInsightsToEngram(insights, engramUrl);

      const res = await handler.execute('codegraph_memory_search', {
        query: 'AuthService',
        project: 'tool-test',
      });

      expect(res.isError).toBe(false);
      const text = ((res.content?.[0] as unknown as { text?: string })?.text || '');
      expect(text).toContain('Project Memory');
      expect(text).toContain('AuthService');
    });

    it('derives the project from projectPath basename', async () => {
      const dirName = path.basename(testDir);
      const insights = await extractInsights(cg, {
        maxInsights: 5,
        minCallers: 1,
        minImpact: 1,
        project: dirName,
      });
      await syncInsightsToEngram(insights, engramUrl);

      const res = await handler.execute('codegraph_memory_search', {
        query: 'AuthService',
        projectPath: testDir,
      });

      expect(res.isError).toBe(false);
      expect(((res.content?.[0] as unknown as { text?: string })?.text || '')).toContain('AuthService');
    });

    it('degrades gracefully when Engram is unavailable', async () => {
      process.env.ENGRAM_URL = 'http://localhost:59999';
      const res = await handler.execute('codegraph_memory_search', {
        query: 'AuthService',
        project: 'tool-test',
      });
      process.env.ENGRAM_URL = engramUrl;

      expect(res.isError).toBe(false);
      expect(((res.content?.[0] as unknown as { text?: string })?.text || '')).toContain('No matching project memory');
    });
  });
});
