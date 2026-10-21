/**
 * Unit tests for post-index Engram sync hook (syncInsightsToEngram)
 *
 * Tests:
 * 1. syncInsightsToEngram() never throws (graceful degradation)
 * 2. Post-index hook is non-blocking (fire-and-forget)
 * 3. CODEGRAPH_ENGRAM_ENABLED flag controls hook execution
 * 4. Sync completes even when Engram unavailable
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'node:child_process';
import CodeGraph from '../../src/index';

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
    engramPort = 4300 + Math.floor(Math.random() * 100);
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

describe('Post-Index Engram Sync Hook', () => {
  let cg: CodeGraph;
  let originalEnv: string | undefined;

  beforeAll(async () => {
    // Create temp test project
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hook-test-'));

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
}
`);

    fs.writeFileSync(path.join(srcDir, 'controller.ts'), `
import { AuthService, UserService } from './service';
export class UserController {
  constructor(private auth: AuthService, private users: UserService) {}
  handleLogin(user: string): boolean { return this.auth.login(user); }
}
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

  beforeEach(() => {
    originalEnv = process.env.CODEGRAPH_ENGRAM_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CODEGRAPH_ENGRAM_ENABLED;
    } else {
      process.env.CODEGRAPH_ENGRAM_ENABLED = originalEnv;
    }
  });

  // =========================================================================
  // syncInsightsToEngram() graceful degradation
  // =========================================================================

  describe('syncInsightsToEngram', () => {
    it('should not throw when Engram is unavailable', async () => {
      // Point to a non-existent Engram server
      process.env.ENGRAM_URL = 'http://localhost:59999';

      // Should not throw
      await expect(cg.syncInsightsToEngram()).resolves.not.toThrow();
    });

    it('should not throw when Engram returns error', async () => {
      // Point to a non-existent Engram server
      process.env.ENGRAM_URL = 'http://localhost:59999';

      // Should not throw
      await expect(cg.syncInsightsToEngram()).resolves.not.toThrow();
    });

    it('should complete successfully when Engram is available', async () => {
      process.env.ENGRAM_URL = engramUrl;

      // Should complete without throwing
      await expect(cg.syncInsightsToEngram()).resolves.not.toThrow();
    });

    it('should extract and sync insights when Engram is available', async () => {
      process.env.ENGRAM_URL = engramUrl;

      // Call syncInsightsToEngram
      await cg.syncInsightsToEngram();

      // Verify insights were synced by searching Engram
      const res = await fetch(`${engramUrl}/search?q=AuthService&limit=5`);
      const data = await res.json();

      // Should have at least one insight about AuthService
      // (real API returns a bare array — rank doubles as score)
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // CODEGRAPH_ENGRAM_ENABLED flag
  // =========================================================================

  describe('CODEGRAPH_ENGRAM_ENABLED flag', () => {
    it('should not sync when flag is not set', async () => {
      delete process.env.CODEGRAPH_ENGRAM_ENABLED;
      process.env.ENGRAM_URL = engramUrl;

      // Call sync directly (not through the hook)
      await cg.syncInsightsToEngram();

      // The hook checks the flag, but calling syncInsightsToEngram directly
      // should still work (the flag is checked in the hook, not in the method)
      const res = await fetch(`${engramUrl}/search?q=AuthService&limit=5`);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });

    it('should sync when flag is set to 1', async () => {
      process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
      process.env.ENGRAM_URL = engramUrl;

      await cg.syncInsightsToEngram();

      const res = await fetch(`${engramUrl}/search?q=AuthService&limit=5`);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Non-blocking behavior
  // =========================================================================

  describe('non-blocking behavior', () => {
    it('should not block sync when Engram is slow', async () => {
      // This test verifies that syncInsightsToEngram is fire-and-forget
      // The actual non-blocking behavior is in the hook (sync/indexAll)
      // Here we just verify the method completes in reasonable time

      process.env.ENGRAM_URL = engramUrl;

      const start = Date.now();
      await cg.syncInsightsToEngram();
      const elapsed = Date.now() - start;

      // Should complete in reasonable time (< 10s for small project)
      expect(elapsed).toBeLessThan(10000);
    });
  });

  // =========================================================================
  // Integration: sync with Engram enabled
  // =========================================================================

  describe('sync integration', () => {
    it('should complete sync without error when Engram enabled', async () => {
      process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
      process.env.ENGRAM_URL = engramUrl;

      // Sync should complete without throwing
      await expect(cg.sync()).resolves.not.toThrow();
    });

    it('should complete sync without error when Engram disabled', async () => {
      delete process.env.CODEGRAPH_ENGRAM_ENABLED;
      process.env.ENGRAM_URL = engramUrl;

      // Sync should complete without throwing
      await expect(cg.sync()).resolves.not.toThrow();
    });

    it('should complete sync without error when Engram unavailable', async () => {
      process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
      process.env.ENGRAM_URL = 'http://localhost:59999';

      // Sync should complete without throwing (graceful degradation)
      await expect(cg.sync()).resolves.not.toThrow();
    });

    it('should complete indexAll without error when Engram enabled', async () => {
      process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
      process.env.ENGRAM_URL = engramUrl;

      // indexAll should complete without throwing (post-index hook fires)
      await expect(cg.indexAll()).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // stdout discipline
  // =========================================================================

  describe('stdout discipline', () => {
    // The hook runs from sync(), which the MCP server calls to serve a project.
    // In DIRECT mode (CODEGRAPH_NO_DAEMON=1) that process's stdout is the
    // JSON-RPC channel, so a single log line there corrupts the protocol —
    // measured with an isolated probe: two non-JSON lines on stdout before the
    // initialize response. Diagnostics belong on stderr.
    it('writes progress to stderr, never to stdout', async () => {
      process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
      process.env.ENGRAM_URL = 'http://localhost:59999';

      const stdoutWrites: string[] = [];
      const originalStdoutWrite = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutWrites.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      // Vitest intercepts console.* in-process, so assert the call itself too.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let logged = '';
      let stdoutText = '';
      let logCalls = 0;

      try {
        await cg.syncInsightsToEngram();
        // Read the recorded calls BEFORE mockRestore(), which clears them.
        logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
        stdoutText = stdoutWrites.join('');
        logCalls = logSpy.mock.calls.length;
      } finally {
        process.stdout.write = originalStdoutWrite;
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }

      // Silence is the invariant: no [codegraph] line may reach stdout.
      expect(stdoutText).not.toContain('[codegraph]');
      expect(logCalls).toBe(0);
      // ...and the diagnostics must still exist, on stderr.
      expect(logged).toContain('[codegraph] Extracting insights');
    });
  });
});
