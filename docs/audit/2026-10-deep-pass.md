# Deep pass audit — October 2026

Branch: `audit/deep-pass-2026-10` (cut from `feature/codegraph-engram-integration`, `main` untouched).

This is a first full-stack pass over the shipped surfaces: the Node engine (SQLite,
extraction, resolution, MCP, CLI, sync) and the Svelte viewer (layout, forms,
accessibility, bundle, responsiveness). It is not a claim that every file was
read line by line; it is the result of a static scan, targeted source review of
the hot paths, the existing test suite, and measurements taken on this machine.

## Method

- Baseline: full build, viewer artifact sizes, `svelte-check`, production and
  development `npm audit`, and a micro-benchmark over the repository's own
  113 MB index (30.6k nodes / 95k edges / 1.17k files).
- Static scan: `TODO/FIXME`, `any`, `@ts-ignore`, empty catches, `SELECT *`,
  timers, focus styles, media queries, accessibility attributes, HTTP headers.
- Targeted review: MCP tool surface, viewer API handlers, DB read paths, static
  file server and path refusals, the viewer shell and palette.
- Every implemented change has a test where the contract is testable; the
  viewer was verified with `svelte-check` and a production build.

## Baseline

| Metric | Before |
|---|---|
| Full build | 100.2 s |
| `dist/` | 77.59 MB |
| viewer (`dist/viewer`) | 1.03 MB |
| initial viewer JS | 507.4 KB (170.2 KB gzip) |
| initial viewer CSS | 100.8 KB (15.6 KB gzip) |
| `svelte-check` | 0 errors, 0 warnings |
| production audit | 1 high (`devalue@5.9.1`) |
| development audit | 12 (2 critical, 5 high) |
| `getTopDependedOn(400)` | 179 ms median, 220 ms cold |
| `getStats()` | 18.7 ms median, 25.6 ms cold |

Index used for the backend numbers: this repository's own `.codegraph/` index.

## Implemented

### Backend

1. **Memoised the most-depended-on ranking** (`src/db/queries.ts`).
   `getTopDependedOn` is a `GROUP BY` over the whole edge table and
   `/api/entrypoints` asks for it on every request. The answer is now cached
   against the connection's change stamp (`total_changes()` +
   `PRAGMA data_version`) and the requested limit, so any write from this
   connection or any other invalidates it. Reads taken inside a transaction are
   never cached: `total_changes()` counts writes a later `ROLLBACK` undoes.
   Effect on this index: **220 ms cold → 0.07–0.66 ms warm**.
2. **Memoised graph statistics** (`src/db/queries.ts`).
   `getStats` runs five full-table aggregates and sits at the top of most
   viewer API handlers. Same change-stamp key; callers receive defensive
   copies so a caller annotating the result cannot poison the next one.
   Effect: **25.6 ms cold → 0.17 ms warm**.
3. **Production dependency patch** (`package.json`).
   `svelte`'s `devalue@5.9.1` carried high-severity advisories
   (GHSA-j22f-vq7h-c4qm, GHSA-mcm9-63f2-9j32). An `overrides` entry pins
   `devalue@^5.9.4`, semver-compatible with Svelte 5.56's `^5.9.2` range.
   Production audit: **1 high → 0**.

### Viewer

4. **On-demand loading of the diagram screens** (`ui/src/views/*ViewLazy.svelte`).
   Map, Screens, Steps and Flow all import `@xyflow/svelte`; together they were
   most of the initial bundle. The four views are now dynamic imports behind
   typed wrappers, so Symbol, File, Entry-points and Dead-code screens never
   download the diagram engine.
   Effect: initial JS **507.4 → 189.9 KB (−63%)**, gzip **170.2 → 66.3 KB
   (−61%)**; initial CSS **100.8 → 52.6 KB**; viewer directory
   **1.03 → 0.93 MB**.
5. **Removed an unused font face** (`ui/src/main.ts`).
   No style in the viewer uses italic; dropping the 400-italic import removes
   its `woff`/`woff2` files from the artifact (~31 KB).
6. **Narrow-window top bar** (`ui/src/components/TopBar.svelte`,
   `SearchPalette.svelte`). Below ~860 px the project badge and brand suffix
   step aside and the tab strip scrolls horizontally instead of pushing the
   search box off-screen; the search column can now shrink (`min-width: 0`) so
   its placeholder no longer holds the grid wider than the window.
7. **`noindex` for the loopback viewer** (`ui/index.html`). The viewer reads a
   local index and has nothing to offer a crawler.

### Tests

- `__tests__/db-read-cache.test.ts` (6 tests): repeated reads are stable, a
  write invalidates both memos, the limit is part of the key, mutating a
  returned value cannot corrupt the cache, both memos are dropped when a
  pooled worker rebinds to a fresh connection, and a value read inside a
  rolled-back transaction is recomputed instead of kept.
- The real-graph API check now asks the index for its busiest node instead of
  pinning `LRUCache.get`, whose fan-in had drifted to 23 on a current index.
  The stopwatch moved to the deterministic fixture (500 callers), because a
  stopwatch over whatever the real index considers busiest measures the
  machine and the index's size. `ui-server-api.test.ts` is green on this
  repository's own index.

## Verified, no change needed

- Path traversal, absolute paths, sensitive roots, symlink escapes and the
  static-asset root all go through one refusal path; the viewer server validates
  `Host`, requires a write header for mutations and sends CSP, `nosniff`,
  `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- The palette already implements the combobox/listbox contract
  (`aria-expanded`, `aria-controls`, `aria-activedescendant`, `role="option"`).
- Focus-visible outlines, `prefers-reduced-motion` and the live-channel backoff
  are already in place.
- MCP tools return success-shaped guidance for expected failures instead of
  `isError`, as designed.

## Deferred

| Item | Why it was not done here |
|---|---|
| Development dependency advisories (vitest/vite/esbuild/rollup) | Requires major upgrades; the shipped production tree is clean. Do it as its own dependency-only change with the full suite on all three platforms. |
| `src/resolution/name-matcher.ts` (704 KB) and `src/mcp/tools.ts` (448 KB) | God files hurt review and navigation, but splitting them is a pure refactor with no runtime gain and a large characterization-test surface. Plan separately. |
| `getAllNodes()` full-table materialiser | Production callers are gone; only tests and comments reference it. Removing it is safe but not urgent. |
| Font payload (458 KB, 176 KB of legacy `.woff`) | Browsers fetch woff2 first; the legacy files only affect package size. Pruning them needs CSS rewriting. |
| Extraction/resolution correctness across languages | Needs the corpus/agent evaluation, not a static pass. |

## Reproduce

```bash
npx vitest run __tests__/db-read-cache.test.ts
npm run check --workspace ui
npm run build
npm audit --omit=dev
```

Backend numbers were taken with a small read-only script that opens
`dist/index.js`, calls `getTopDependedOn(400)` / `getStats()` once (cold) and
then 20 times (warm), timing each call with `process.hrtime.bigint()`.
