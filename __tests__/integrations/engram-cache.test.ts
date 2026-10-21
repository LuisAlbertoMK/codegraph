/**
 * Unit tests for the Engram memory-search cache bound.
 *
 * The MCP daemon outlives sessions, so the cache must not accumulate one entry
 * per distinct question. These tests drive the real search path with a fake
 * `fetch` and observe eviction through the requests it produces — no server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  searchEngramMemory,
  clearMemoryCache,
  MEMORY_CACHE_MAX_ENTRIES,
} from '../../src/integrations/engram-sync';

const BACKEND = 'http://cache-test.invalid';

/** Fake Engram `/search`: always one strict hit, and records each request. */
function stubEngram(): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const q = new URL(url).searchParams.get('q') ?? '';
    return new Response(
      JSON.stringify([{ title: `hit ${q}`, content: `memory about ${q}`, rank: -1, type: 'decision' }]),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return calls;
}

const ask = (query: string): Promise<unknown> =>
  searchEngramMemory(query, { project: 'cache-test', engramUrl: BACKEND });

describe('Engram memory search cache bound', () => {
  beforeEach(() => {
    clearMemoryCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMemoryCache();
  });

  it('stays at the bound and evicts the least recently asked', async () => {
    const calls = stubEngram();

    for (let i = 0; i < MEMORY_CACHE_MAX_ENTRIES; i++) await ask(`query${i}`);
    expect(calls.length).toBe(MEMORY_CACHE_MAX_ENTRIES);

    // Over the bound by one: the oldest question is the one that goes.
    await ask('one-more');
    expect(calls.length).toBe(MEMORY_CACHE_MAX_ENTRIES + 1);

    // The newcomer is cached — no request.
    await ask('one-more');
    expect(calls.length).toBe(MEMORY_CACHE_MAX_ENTRIES + 1);

    // The first question was evicted — asking again reaches Engram.
    await ask('query0');
    expect(calls.length).toBe(MEMORY_CACHE_MAX_ENTRIES + 2);

    // The last one filled is still cached.
    await ask(`query${MEMORY_CACHE_MAX_ENTRIES - 1}`);
    expect(calls.length).toBe(MEMORY_CACHE_MAX_ENTRIES + 2);
  });

  it('counts a repeated question as recent, so it survives the next eviction', async () => {
    const calls = stubEngram();

    for (let i = 0; i < MEMORY_CACHE_MAX_ENTRIES; i++) await ask(`query${i}`);
    const afterFill = calls.length;

    // Re-asking moves query0 to the hot end (served from cache, no request).
    await ask('query0');
    expect(calls.length).toBe(afterFill);

    // Overflow by one: query1 is now the least recently asked.
    await ask('overflow');
    expect(calls.length).toBe(afterFill + 1);

    await ask('query0');
    expect(calls.length).toBe(afterFill + 1);
    await ask('query1');
    expect(calls.length).toBe(afterFill + 2);
  });
});
