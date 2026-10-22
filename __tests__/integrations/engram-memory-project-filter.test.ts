/**
 * Memory tools must never search Engram unfiltered.
 *
 * Engram's `/search` without a `project` parameter answers from every project
 * on the machine, so an unfiltered call hands one repository's memory to a
 * session working in another. The filter comes from `projectPath` when the
 * caller names one, and from this session's own project root when it does not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/index';
import { ToolHandler, __setLoadCodeGraphForTests } from '../../src/mcp/tools';
import { clearMemoryCache } from '../../src/integrations/engram-sync';

describe('codegraph_memory_search — Engram project filter', () => {
  let testDir: string;
  let otherDir: string;
  let cg: CodeGraph | null;
  let handler: ToolHandler | null;
  let searches: URL[];

  const projectOf = (url: URL): string | null => url.searchParams.get('project');

  beforeEach(() => {
    clearMemoryCache();
    // `projectPath` opens a second project through the lazy require, which
    // vitest's transform cannot service in-process (see the injector's docs).
    __setLoadCodeGraphForTests(CodeGraph);
    searches = [];
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mem-home-'));
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mem-other-'));
    fs.writeFileSync(path.join(testDir, 'a.ts'), 'export function a() { return 1; }\n');
    fs.writeFileSync(path.join(otherDir, 'b.ts'), 'export function b() { return 2; }\n');
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    // An indexed path, so the call reaches the memory handler: `execute` opens
    // `projectPath` first and answers un-indexed roots with guidance instead.
    const other = CodeGraph.initSync(otherDir, { config: { include: ['**/*.ts'], exclude: [] } });
    other.close();
    handler = new ToolHandler(cg);

    // Every request the search makes — the strict one and the per-term
    // fallback — is recorded, because any unfiltered one is the bug.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      searches.push(new URL(String(input)));
      return new Response('[]', { status: 200 });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    __setLoadCodeGraphForTests(null);
    await handler?.closeAll();
    handler = null;
    try { cg?.destroy(); } catch { /* best effort */ }
    cg = null;
    for (const dir of [testDir, otherDir]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("filters by this session's own project when the caller names no path", async () => {
    const result = await handler!.execute('codegraph_memory_search', { query: 'auth service' });

    expect(result.isError).toBeFalsy();
    expect(searches.length).toBeGreaterThan(0);
    for (const url of searches) {
      expect(url.pathname).toBe('/search');
      expect(projectOf(url)).toBe(path.basename(testDir));
    }
  });

  it('filters by projectPath when the caller names one', async () => {
    const result = await handler!.execute('codegraph_memory_search', {
      query: 'auth service',
      projectPath: otherDir,
    });

    expect(result.isError).toBeFalsy();
    expect(searches.length).toBeGreaterThan(0);
    for (const url of searches) {
      expect(projectOf(url)).toBe(path.basename(otherDir));
    }
  });

  it('lets an explicit project name win over the path', async () => {
    const result = await handler!.execute('codegraph_memory_search', {
      query: 'auth service',
      projectPath: otherDir,
      project: 'pinned-project',
    });

    expect(result.isError).toBeFalsy();
    expect(searches.length).toBeGreaterThan(0);
    for (const url of searches) {
      expect(projectOf(url)).toBe('pinned-project');
    }
  });
});
