# CodeGraph ↔ Engram Integration

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
│  engram-client           │          │  Observations stored    │
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
- [ ] 1.1 Create Engram stub server (mock HTTP API matching real Engram endpoints)
- [ ] 1.2 Create benchmark baseline: measure current codegraph explore latency + token usage
- [ ] 1.3 Document baseline metrics in docs/benchmarks/

### Phase 2: Insight Extractor
- [ ] 2.1 Create `src/integrations/engram-sync.ts` module
- [ ] 2.2 Implement `extractInsights(graph)` — top symbols by callers/impact
- [ ] 2.3 Implement deduplication key generation
- [ ] 2.4 Add unit tests for insight extraction

### Phase 3: Engram HTTP Client
- [ ] 3.1 Create `src/integrations/engram-client.ts`
- [ ] 3.2 Implement `saveInsight()` — POST to Engram stub
- [ ] 3.3 Implement `searchMemory()` — GET from Engram stub
- [ ] 3.4 Add retry logic + timeout handling
- [ ] 3.5 Add unit tests for client

### Phase 4: MCP Cross-Tool
- [ ] 4.1 Add `explore_with_memory` tool to MCP server
- [ ] 4.2 Implement memory enrichment in explore results
- [ ] 4.3 Add graceful degradation when Engram unavailable
- [ ] 4.4 Add integration tests

### Phase 5: Post-Index Hook
- [ ] 5.1 Wire insight extractor into sync/index flow
- [ ] 5.2 Make hook non-blocking (fire-and-forget)
- [ ] 5.3 Add configuration flag: `CODEGRAM_ENGRAM_ENABLED`
- [ ] 5.4 Add logging for sync operations

### Phase 6: Benchmarks + Docs
- [ ] 6.1 Run benchmarks: explore latency with/without memory enrichment
- [ ] 6.2 Run benchmarks: index time with/without insight extraction
- [ ] 6.3 Write docs/integrations/engram.md
- [ ] 6.4 Write CHANGELOG entry
- [ ] 6.5 Update server-instructions.ts if needed

### Phase 7: Two-Stage Ranking + Single MCP (done)
- [x] 7.1 Two-stage insight ranking (callers first, impact only for top-200 pool, 4x headroom over overlap evidence)
- [x] 7.2 Native `codegraph_memory_search` MCP tool (code + memory through one CodeGraph MCP server)
- [x] 7.3 Ranking-equivalence + tool tests (36/36 green, tsc clean)

## Success Criteria

- [ ] `explore_with_memory` returns flow + relevant memory in < 500ms overhead
- [ ] Post-index sync adds < 10% to index time
- [ ] Graceful degradation when Engram is down (explore still works)
- [ ] All tests pass
- [ ] Benchmark docs show measurable improvement

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
- Integration test: 10 insights extracted, 9 created + 1 updated, dedup works (0 created, 10 updated on re-sync)
- Docs: docs/integrations/engram.md
- CHANGELOG: Entry under [Unreleased] > New Features
