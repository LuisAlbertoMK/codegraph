/**
 * Unit tests for pruning insights whose symbol no longer exists.
 *
 * The graph owner passes `stillExists`; only then can "deleted" be told apart
 * from "not in this run's top N". A fake `fetch` records the DELETEs, and the
 * sync state file on disk is the other half of the contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { syncInsightsToEngram } from '../../src/integrations/engram-sync';

const BACKEND = 'http://prune-test.invalid';
const PROJECT = 'prune-project';

/** Git is the detector for "this state file came from the repository". */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

type Call = { method: string; url: URL };

let root: string;

function writeState(entries: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.codegraph', 'engram-sync-state.json'),
    JSON.stringify({ version: 3, entries })
  );
}

function readState(): { version: number; entries: Record<string, { id: number | string }> } {
  return JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'engram-sync-state.json'), 'utf8'));
}

/** Fake Engram: records every call, answers by method. */
function stubEngram(deleteStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    if (method === 'DELETE') {
      return deleteStatus === 200
        ? new Response(JSON.stringify({ status: 'deleted', hard_delete: false }), { status: 200 })
        : new Response(JSON.stringify({ error: 'boom' }), { status: deleteStatus });
    }
    if (url.pathname === '/sessions') {
      return new Response(JSON.stringify({ id: 'sync-session' }), { status: 201 });
    }
    if (url.pathname === '/observations') {
      return new Response(JSON.stringify({ id: 101 }), { status: 201 });
    }
    return new Response('[]', { status: 200 });
  });
  return calls;
}

const deletes = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'DELETE');

describe('Engram insight pruning', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-prune-test-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('deletes the observation of a symbol the graph no longer has, and only that one', async () => {
    writeState({
      'codegraph:prune-project:src/live.ts:src/live.ts::live': {
        id: 11, hash: 'h1', filePath: 'src/live.ts', qualifiedName: 'src/live.ts::live',
      },
      'codegraph:prune-project:src/gone.ts:src/gone.ts::gone': {
        id: 12, hash: 'h2', filePath: 'src/gone.ts', qualifiedName: 'src/gone.ts::gone',
      },
      // Pre-v3 entry: no identity, so it cannot be verified — left alone.
      'codegraph:prune-project:src/old.ts:src/old.ts::old': { id: 13, hash: 'h3' },
    });
    const calls = stubEngram();

    // No insights this run: the prune is gated by the graph view, not by them.
    const result = await syncInsightsToEngram([], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: (filePath, qualifiedName) =>
        filePath === 'src/live.ts' && qualifiedName === 'src/live.ts::live',
    });

    expect(result.pruned).toBe(1);
    expect(result.pruneFailed).toBe(0);

    expect(deletes(calls)).toHaveLength(1);
    expect(deletes(calls)[0]?.url.pathname).toBe('/observations/12');
    expect(deletes(calls)[0]?.url.searchParams.get('expected_project')).toBe(PROJECT);

    const state = readState();
    expect(state.version).toBe(3);
    expect(Object.keys(state.entries)).toEqual([
      'codegraph:prune-project:src/live.ts:src/live.ts::live',
      'codegraph:prune-project:src/old.ts:src/old.ts::old',
    ]);
  });

  it('never deletes when the caller supplies no graph view', async () => {
    writeState({
      'codegraph:prune-project:src/gone.ts:src/gone.ts::gone': {
        id: 12, hash: 'h2', filePath: 'src/gone.ts', qualifiedName: 'src/gone.ts::gone',
      },
    });
    const calls = stubEngram();

    const result = await syncInsightsToEngram([], BACKEND, { rootDir: root, project: PROJECT });

    expect(result.pruned).toBe(0);
    expect(deletes(calls)).toHaveLength(0);
    expect(Object.keys(readState().entries)).toHaveLength(1);
  });

  it('treats a 404 as already gone and keeps the entry when the server refuses', async () => {
    writeState({
      'codegraph:prune-project:src/a.ts:src/a.ts::a': {
        id: 21, hash: 'a', filePath: 'src/a.ts', qualifiedName: 'src/a.ts::a',
      },
      'codegraph:prune-project:src/b.ts:src/b.ts::b': {
        id: 22, hash: 'b', filePath: 'src/b.ts', qualifiedName: 'src/b.ts::b',
      },
    });
    const calls = stubEngram(404);

    const result = await syncInsightsToEngram([], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: () => false,
    });

    expect(result.pruned).toBe(2);
    expect(result.pruneFailed).toBe(0);
    expect(deletes(calls)).toHaveLength(2);
    expect(Object.keys(readState().entries)).toHaveLength(0);
  });

  it('keeps the entry for a later retry when the delete fails', async () => {
    writeState({
      'codegraph:prune-project:src/a.ts:src/a.ts::a': {
        id: 31, hash: 'a', filePath: 'src/a.ts', qualifiedName: 'src/a.ts::a',
      },
    });
    const calls = stubEngram(500);

    const result = await syncInsightsToEngram([], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: () => false,
    });

    expect(result.pruned).toBe(0);
    expect(result.pruneFailed).toBe(1);
    expect(deletes(calls).length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(readState().entries)).toHaveLength(1);
  });

  it('prunes alongside a normal sync, recording identity for each posted insight', async () => {    writeState({
      'codegraph:prune-project:src/gone.ts:src/gone.ts::gone': {
        id: 41, hash: 'old', filePath: 'src/gone.ts', qualifiedName: 'src/gone.ts::gone',
      },
    });
    const calls = stubEngram();

    const result = await syncInsightsToEngram([{
      deduplication_key: 'codegraph:prune-project:src/new.ts:src/new.ts::fresh',
      title: 'src/new.ts::fresh — 4 callers, 9 impacted',
      content: 'Symbol: src/new.ts::fresh',
      type: 'symbol',
      project: PROJECT,
      name: 'fresh',
      qualifiedName: 'src/new.ts::fresh',
      filePath: 'src/new.ts',
      startLine: 1,
      callerCount: 4,
      impactCount: 9,
      topCallers: ['caller'],
      topImpacted: ['callee'],
      confidence: 0.6,
    }], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: (filePath, qualifiedName) =>
        filePath === 'src/new.ts' && qualifiedName === 'src/new.ts::fresh',
    });

    expect(result.created).toBe(1);
    expect(result.pruned).toBe(1);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(2); // session + observation
    expect(deletes(calls)).toHaveLength(1);
    expect(deletes(calls)[0]?.url.pathname).toBe('/observations/41');

    const entries = readState().entries;
    expect(Object.keys(entries)).toEqual(['codegraph:prune-project:src/new.ts:src/new.ts::fresh']);
    expect(entries['codegraph:prune-project:src/new.ts:src/new.ts::fresh']).toMatchObject({
      id: 101, filePath: 'src/new.ts', qualifiedName: 'src/new.ts::fresh',
    });
  });

  it('never deletes when nobody declared a project', async () => {
    writeState({
      'codegraph:prune-project:src/gone.ts:src/gone.ts::gone': {
        id: 51, hash: 'h5', filePath: 'src/gone.ts', qualifiedName: 'src/gone.ts::gone',
      },
    });
    const calls = stubEngram();

    // No option and no insight: the old fallback aimed this at the literal
    // 'codegraph' project, which is somebody else's memory namespace.
    const result = await syncInsightsToEngram([], BACKEND, {
      rootDir: root,
      stillExists: () => false,
    });

    expect(result.pruned).toBe(0);
    expect(deletes(calls)).toHaveLength(0);
    expect(Object.keys(readState().entries)).toHaveLength(1);
  });

  it.runIf(hasGit)('ignores a state file the repository tracks', async () => {
    writeState({
      'codegraph:prune-project:src/gone.ts:src/gone.ts::gone': {
        id: 61, hash: 'h6', filePath: 'src/gone.ts', qualifiedName: 'src/gone.ts::gone',
      },
    });
    // `.codegraph/` is gitignored, so a state file in git was force-added:
    // it is repository content, and every entry in it is a delete request.
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '-f', '.codegraph/engram-sync-state.json'], { cwd: root, stdio: 'ignore' });
    const calls = stubEngram();

    const result = await syncInsightsToEngram([], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: () => false,
    });

    expect(result.pruned).toBe(0);
    expect(result.pruneFailed).toBe(0);
    expect(deletes(calls)).toHaveLength(0);
  });

  it.runIf(hasGit)('still prunes from a state file git does not track', async () => {
    writeState({
      'codegraph:prune-project:src/gone.ts:src/gone.ts::gone': {
        id: 71, hash: 'h7', filePath: 'src/gone.ts', qualifiedName: 'src/gone.ts::gone',
      },
    });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const calls = stubEngram();

    const result = await syncInsightsToEngram([], BACKEND, {
      rootDir: root,
      project: PROJECT,
      stillExists: () => false,
    });

    expect(result.pruned).toBe(1);
    expect(deletes(calls)[0]?.url.pathname).toBe('/observations/71');
  });
});
