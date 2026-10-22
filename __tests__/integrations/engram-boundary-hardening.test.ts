/**
 * The edges of the Engram bridge that face untrusted input: HTTP responses and
 * the predictable files inside `.codegraph/`.
 *
 * `fetch` follows redirects by default, and a 3xx is the one way a request
 * aimed at loopback can be re-sent off the machine. The state file is worse:
 * its entries become deletes, so the file must be the one this machine wrote,
 * not a link planted in the project. Both are cheap to check and easy to lose
 * in a refactor, which is what these cases pin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ENGRAM_TIMEOUT_CEILING_MS,
  readEngramTimeoutMs,
  syncInsightsToEngram,
} from '../../src/integrations/engram-sync';
import { logEngram } from '../../src/integrations/engram-log';

const BACKEND = 'http://boundary-test.invalid';
const PROJECT = 'boundary-project';
const STATE = path.join('.codegraph', 'engram-sync-state.json');
const LOG = path.join('.codegraph', 'engram-debug.jsonl');

let root: string;

function writeState(entries: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(root, STATE), JSON.stringify({ version: 3, entries }));
}

/** A stale entry: pruning would delete observation 99 if it were trusted. */
const STALE = {
  'codegraph:boundary-project:src/gone.ts:src/gone.ts::gone': {
    id: 99, hash: 'h', filePath: 'src/gone.ts', qualifiedName: 'src/gone.ts::gone',
  },
};

/** Something to post, so a run reaches the state write. */
const INSIGHT = {
  deduplication_key: 'codegraph:boundary-project:src/live.ts:src/live.ts::live',
  title: 'src/live.ts::live — 3 callers, 5 impacted',
  content: 'Symbol: src/live.ts::live',
  type: 'symbol' as const,
  project: PROJECT,
  name: 'live',
  qualifiedName: 'src/live.ts::live',
  filePath: 'src/live.ts',
  startLine: 1,
  callerCount: 3,
  impactCount: 5,
  topCallers: ['caller'],
  topImpacted: ['callee'],
  confidence: 0.6,
};

type Call = { method: string; url: URL; init?: RequestInit };

function stubEngram(calls: Call[]): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url: new URL(String(input)), init });
    if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
      return new Response(JSON.stringify({ status: 'deleted' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 1 }), { status: 201 });
  });
}

const deletes = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'DELETE');

/** Symlinks need a privilege on Windows (Developer Mode); skip when denied. */
function canCreateSymlinks(dir: string): boolean {
  const probe = path.join(dir, `.symlink-probe-${process.pid}`);
  const target = path.join(dir, `.symlink-target-${process.pid}`);
  try {
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, probe);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
  }
}

const CAN_SYMLINK = canCreateSymlinks(os.tmpdir());

describe('Engram boundary hardening', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-boundary-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CODEGRAPH_ENGRAM_DEBUG;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('clamps the request timeout instead of obeying an unbounded value', () => {
    expect(readEngramTimeoutMs({ ENGRAM_TIMEOUT_MS: '999999999' })).toBe(ENGRAM_TIMEOUT_CEILING_MS);
    expect(readEngramTimeoutMs({ ENGRAM_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(readEngramTimeoutMs({ ENGRAM_TIMEOUT_MS: 'nonsense' })).toBe(10_000);
    expect(readEngramTimeoutMs({ ENGRAM_TIMEOUT_MS: '0' })).toBe(10_000);
    expect(readEngramTimeoutMs({})).toBe(10_000);
  });

  it('refuses redirects on every request it makes', async () => {
    writeState(STALE);
    const calls: Call[] = [];
    stubEngram(calls);

    await syncInsightsToEngram([INSIGHT], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: () => true,
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.init?.redirect).toBe('error');
    }
  });

  it.runIf(CAN_SYMLINK)('ignores a state file that is a symlink', async () => {
    const outside = path.join(root, 'outside-state.json');
    fs.writeFileSync(outside, JSON.stringify({ version: 3, entries: STALE }));
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, STATE));
    const calls: Call[] = [];
    stubEngram(calls);

    const result = await syncInsightsToEngram([], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: () => false,
    });

    expect(result.pruned).toBe(0);
    expect(deletes(calls)).toHaveLength(0);
  });

  it.runIf(CAN_SYMLINK)('never writes the state file through a symlink', async () => {
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, 'untouched');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, STATE));
    const calls: Call[] = [];
    stubEngram(calls);

    const result = await syncInsightsToEngram([INSIGHT], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: () => true,
    });

    // The run posts (state load was refused), so it reaches the save.
    expect(result.created).toBe(1);
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
  });

  it('ignores a state file too large to parse on every sync', async () => {
    // Still VALID json holding the stale entry: without the size bound this
    // file parses and the entry is pruned, which is exactly what must not
    // happen. A corrupt oversized file would pass for the wrong reason.
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.writeFileSync(
      path.join(root, STATE),
      JSON.stringify({ version: 3, entries: STALE, pad: 'a'.repeat(4 * 1024 * 1024) }),
    );
    const calls: Call[] = [];
    stubEngram(calls);

    const result = await syncInsightsToEngram([], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: () => false,
    });

    expect(result.pruned).toBe(0);
    expect(deletes(calls)).toHaveLength(0);
  });

  it.runIf(CAN_SYMLINK)('does not append the trace through a symlink', () => {
    const outside = path.join(root, 'outside.log');
    fs.writeFileSync(outside, 'untouched');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, LOG));

    process.env.CODEGRAPH_ENGRAM_DEBUG = '1';
    logEngram('boundary.test', { secret: 'do-not-leak' }, root);

    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
  });
});
