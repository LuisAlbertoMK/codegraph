# CodeGraph ↔ Engram Integration

## Status

Implemented and verified. **Not released** — the feature lives under `CHANGELOG.md` → `[Unreleased] > New Features`, so users on the latest release cannot use it yet.

- Last verified: 38/38 integration tests green (`__tests__/integrations/`), `tsc --noEmit` clean.
- Opt-in twice: `CODEGRAPH_ENGRAM_ENABLED=1` enables the post-index hook, **and** `CODEGRAPH_MCP_TOOLS` must list the memory tools — the default MCP surface exposes only `codegraph_explore`.

## Goal

Integrate CodeGraph (structural code intelligence) with Engram (persistent semantic memory) so that an AI agent can:
1. Explore code with CodeGraph and automatically enrich results with project memory from Engram
2. Extract key insights during indexing and persist them to Engram automatically
3. Recall both code structure and accumulated memory in future sessions

## Architecture

```
CodeGraph (TypeScript/Node)          Engram (Go/SQLite)
┌─────────────────────────┐          ┌─────────────────────────┐
│  index/sync             │          │  HTTP API + MCP         │
│    ↓ post-index hook     │          │    POST /observations   │
│  insight extractor       │──────────│    GET /search          │
│    ↓                     │  HTTP    │                         │
│  engram-sync             │          │  Observations stored    │
│                         │          │  with dedup keys        │
│  MCP server              │          │                         │
│    explore_with_memory   │          │                         │
│    ↓                     │          │                         │
│  Agent gets flow + memory│          │                         │
└─────────────────────────┘          └─────────────────────────┘
```

## Non-Goals (this iteration)

- Modifying Engram Go source (stub instead)
- Cloud sync features
- Bi-directional real-time sync
- Replacing Engram's MCP server

## Tasks

### Phase 1: Foundation + Baseline
- [x] 1.1 Create Engram stub server (mock HTTP API matching real Engram endpoints) — `scripts/engram-stub.mjs`
- [x] 1.2 Create benchmark baseline: measure current codegraph explore latency + token usage — `scripts/benchmark-baseline.mjs`
- [x] 1.3 Document baseline metrics in docs/benchmarks/ — `docs/benchmarks/engram-integration-baseline.json`

### Phase 2: Insight Extractor
- [x] 2.1 Create `src/integrations/engram-sync.ts` module
- [x] 2.2 Implement `extractInsights(graph)` — top symbols by callers/impact
- [x] 2.3 Implement deduplication key generation
- [x] 2.4 Add unit tests for insight extraction

### Phase 3: Engram HTTP Client
- [x] 3.1 Engram HTTP client — lives in `src/integrations/engram-sync.ts` (never split into a separate `engram-client.ts`)
- [x] 3.2 Implement `saveInsight()` — POST to Engram stub
- [x] 3.3 Implement `searchMemory()` — GET from Engram stub
- [x] 3.4 Add timeout handling — `fetchWithTimeout` + `ENGRAM_TIMEOUT_MS` (AbortController)
- [x] 3.4b Add retry/backoff — transient failures only (network error, 5xx, 429), `ENGRAM_RETRY_ATTEMPTS` (default 3), full-jitter backoff, sharing the ONE `ENGRAM_TIMEOUT_MS` window so a hung Engram still sees exactly one request. A 4xx is never retried. 5 tests in `__tests__/integrations/engram-sync.test.ts`
- [x] 3.5 Add unit tests for client

### Phase 4: MCP Cross-Tool
- [x] 4.1 Add `explore_with_memory` tool to MCP server
- [x] 4.2 Implement memory enrichment in explore results
- [x] 4.3 Add graceful degradation when Engram unavailable
- [x] 4.4 Add integration tests

### Phase 5: Post-Index Hook
- [x] 5.1 Wire insight extractor into sync/index flow
- [x] 5.2 Make hook non-blocking (fire-and-forget)
- [x] 5.3 Add configuration flag: `CODEGRAPH_ENGRAM_ENABLED` (plus `CODEGRAPH_MCP_TOOLS` for the tool surface)
- [x] 5.4 Add logging for sync operations

### Phase 6: Benchmarks + Docs
- [x] 6.1 Run benchmarks: explore latency with/without memory enrichment
- [x] 6.2 Run benchmarks: index time with/without insight extraction
- [x] 6.3 Write docs/integrations/engram.md
- [x] 6.4 Write CHANGELOG entry
- [x] 6.5 Update server-instructions.ts — not needed: the memory tools are not listed to agents by default, so there was nothing to steer.

### Phase 7: Two-Stage Ranking + Single MCP (done)
- [x] 7.1 Two-stage insight ranking (callers first, impact only for top-200 pool, 4x headroom over overlap evidence)
- [x] 7.2 Native `codegraph_memory_search` MCP tool (code + memory through one CodeGraph MCP server)
- [x] 7.3 Ranking-equivalence + tool tests (38/38 green, tsc clean)

## Success Criteria

- [x] `explore_with_memory` returns flow + relevant memory in < 500ms overhead — ~35ms on the real MCP path, 140ms via the CLI proxy
- [x] Post-index sync does not block indexing — fire-and-forget; extraction runs in the background (~2.5s for 30 insights, 0ms added to the index path)
- [x] Graceful degradation when Engram is down (explore still works) — covered by tests, including a hanging server
- [x] All tests pass — 38/38 integration tests, `tsc --noEmit` clean
- [x] Benchmark docs reflect what was actually measured — enrichment *cost*, not a speed-up: the integration adds memory context, it does not make explore faster (`docs/benchmarks/engram-integration-*.json`)

## Evidence

- Baseline benchmarks: docs/benchmarks/engram-integration-baseline.json
  - Avg latency: 2470ms (first run 2437ms), Total chars: 124K
- Post-implementation benchmarks: docs/benchmarks/engram-integration-post-implementation.json
  - Normal explore avg: 2115ms
  - With memory avg: 2255ms
  - Overhead: 140ms (6.6%; earlier local run: 80ms/3.5%) — single-digit %; absolutes vary run-to-run
- Hook cost measured directly on the full repo graph: 8.6s for 30 insights (8.4s extract + 0.2s sync), non-blocking
- Two-stage ranking: extraction 8.4s→6.5s (~1.3x); impact walks 2116→230. Next lever for x2+: count-only impact in the engine
- Level-batched BFS impact (getImpactIdsBatched): parity 0/200 mismatches vs recursive on the real repo, walk microbench 3.24x; extraction end-to-end 8.4s→~2.5s (~x3, n=3 runs) with identical top-30
- Gaps closed: ENGRAM_TIMEOUT_MS abort (hung Engram can't stall the hook, tested with hanging server), flow insights bind exact node ids (no short-name re-resolve), honest MCP-path benchmark `benchmark-mcp-memory.mjs` (~35ms enrichment overhead)
- Real-Engram retarget: client rewritten to the actual v3 API (idempotent per-project sync sessions, dedup upsert, rank-as-score, stopword-stripped queries); stub mirrors it; project opencode session runs local dist MCP against 127.0.0.1:7437. Real-use proof: natural query enriches with the relevant session memory; code insights visible via mem_search (one store).
- Autonomous battery vs real backend: extraction 2.1–2.9s (n=3); sync POST+GET-revision ×30 ≈ 2.1s (sequential; parallelizing is the next lever, est. ~0.2s); MCP-path enrichment overhead ≈ 0ms (1/−26/−2, hasMemory 2/3); CLI-proxy post number currently load-contaminated (baseline itself swung 2115→3264 across runs) — mcp-memory is the honest benchmark.
- Parallel sync (8 lanes) measured: NO wall gain vs Engram v3.3.0 (8 seq 385ms vs 8 par 298ms — server serializes writes at ~40–48ms each). Kept anyway: correct, tested, faster vs parallel-capable servers. True next lever is fewer calls (local synced-keys state → skip GETs; or incremental sync).
- Synced-keys state (`.codegraph/engram-sync-state.json`): steady-state sync skips 30 revision GETs → sync ~2.1s→~1.6s (~25%); POSTs remain the floor (30 serialized server writes). 38/38 tests.
- Incremental sync (content-hash v2 state): steady-state sync posts NOTHING — 5ms, 0/0/0. Determinism fixed en route (identity tie-breaks + file-qualified dedup keys; two `Node` defs no longer flip-flop or clobber each other).
- Integration test: 10 insights extracted, 9 created + 1 updated, dedup works (0 created, 10 updated on re-sync)
- Docs: docs/integrations/engram.md
- CHANGELOG: Entry under [Unreleased] > New Features
