# Engram Integration

CodeGraph can integrate with [Engram](https://github.com/Gentleman-Programming/engram) to provide persistent memory for AI coding agents. This integration allows agents to:

1. **Explore code with memory context** — `codegraph_explore_with_memory` enriches code flow results with relevant project memory from Engram
2. **Auto-sync insights** — after indexing, key symbols and flows are automatically persisted to Engram for cross-session recall
3. **Search memory directly** — `codegraph_memory_search` recalls past decisions and insights with no code flow, so a single CodeGraph MCP server covers code + memory (no second MCP server needed; opt in with `CODEGRAPH_MCP_TOOLS=explore,memory_search,explore_with_memory` — the default surface lists only `codegraph_explore`)

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

## Configuration

### Enable Engram Sync

Set the environment variable before running CodeGraph:

```bash
export CODEGRAPH_ENGRAM_ENABLED=1
export ENGRAM_URL=http://127.0.0.1:7437  # Engram HTTP API URL (engram serve default port)
export ENGRAM_TIMEOUT_MS=10000  # Engram HTTP timeout in ms (default: 10000)
export CODEGRAPH_MCP_TOOLS=explore,memory_search,explore_with_memory  # expose memory tools (default: explore only)
```

### Disable Engram Sync

```bash
unset CODEGRAPH_ENGRAM_ENABLED
# or
export CODEGRAPH_ENGRAM_ENABLED=0
```

## MCP Tools

### `codegraph_explore_with_memory`

Same as `codegraph_explore` but automatically enriches results with relevant project memory from Engram.

**Parameters:**
- `query` (string, required) — Symbol names, file names, or code terms to explore
- `maxFiles` (number, optional) — Maximum files to include source from (default: 12)
- `projectPath` (string, optional) — Project path
- `includeMemory` (boolean, optional) — Whether to enrich with Engram memory (default: true)

**Behavior:**
1. Calls normal `codegraph_explore` to get code flow
2. Searches Engram for relevant memory (top 3 results)
3. Prepends memory section to explore output
4. Gracefully degrades to normal explore if Engram is unavailable

**Example output:**
```
**Project Memory (from Engram)**

- **CodeGraph — 782 callers, 1270 impacted** (symbol, score: 1)
  Symbol: CodeGraph
  File: src/index.ts:149
  Callers: 782 (indexAll, sync, open, ...)
  Impact: 1270 nodes affected

---

**Exploration: CodeGraph.indexAll**

Found 83 symbols across 5 files.
...
```

### `codegraph_memory_search`

Direct recall over persistent memory — no code flow. Pairs with `codegraph_explore` (or use `codegraph_explore_with_memory` for both in one call).

**Parameters:**
- `query` (string, required) — What to recall (symbol names, topics, or questions about past work)
- `limit` (number, optional) — Maximum memories to return (default: 5, max: 50)
- `project` (string, optional) — Engram project name (exact match)
- `projectPath` (string, optional) — Falls back to the indexed project name (directory basename), the same derivation the post-index hook uses

**Behavior:**
1. Searches Engram for relevant memory (top results by relevance)
2. Returns titled memories with type and score
3. Returns gracefully (never errors) when Engram is unavailable or nothing matches

**Memory search cache:** answers are cached per backend server, project,
query and result count for 60 seconds, so repeated questions in a session
don't hit Engram again. Strict misses fall back to per-term retrieval under
its own cache entry, keeping fresh strict matches discoverable.

## Insight Extraction

After each index/sync, CodeGraph extracts key insights and persists them to Engram:

### Insight Types

- **symbol** — Top symbols by caller count and impact radius
- **flow** — Call paths through central symbols
- **pattern** — Detected design patterns (future)
- **architecture** — High-level architectural insights (future)

### Extraction Criteria

- Minimum 3 callers (direct)
- Minimum 5 nodes in impact radius
- Maximum 50 insights per sync (configurable)
- Confidence score based on caller count + impact radius

### Extraction performance

Ranking walks a candidate pool (at most 100 by caller count) once and
reuses each walk when building the final insights; node loading is a single
query and only the first few impacted ids of each hub are sampled, skipping
the hub itself (its own name is not a useful neighbor). Selection and counts
are identical to walking everything twice — the ranking is pinned by tests
against brute-force scoring, and tests pin that the focal symbol never
appears among topImpacted.

### Deduplication

Each insight carries a `deduplication_key`:
```
codegraph:{project}:{file_path}:{qualified_name}
```

Re-indexing updates existing observations instead of duplicating them.
The file path is part of the key: a qualified name alone collides across
definitions (two `Node` interfaces in different files would clobber each
other on every sync).

### Sync state

Syncs after the first one skip insights whose content hash matches the
local record in `.codegraph/engram-sync-state.json`, so steady-state syncs
usually post nothing. Whether a synced insight counts as created or updated
also comes from that record — the sync never re-checks with the server —
so a first sync takes about one request per insight plus the session setup.
Without a project root (stateless scripts and tests) there is no record and
re-syncs count everything as created; the server still upserts by key, so no
duplicates are stored.

## Benchmarks

### Baseline (without Engram)

- Average explore latency: 2470ms (earlier local runs ranged 2248–2470ms)
- Total output: 124K chars

### With Engram Integration

- Average explore latency: 2255ms (normal explore in the same run: 2115ms)
- Memory enrichment overhead: ~35ms on the real MCP path (`benchmark-mcp-memory.mjs`); CLI-proxy measurement: 140ms (6.6%)
- Insight sync: ~2.5s for 30 insights on a 10k-file repo (batched impact walks, non-blocking fire-and-forget; first syncs now take about one request per insight with no per-insight re-check, and steady-state syncs skip unchanged insights)

See `docs/benchmarks/engram-integration-baseline.json` and `docs/benchmarks/engram-integration-post-implementation.json` for full results.

## Development

### Engram Stub Server

For development without a real Engram instance:

```bash
node scripts/engram-stub.mjs
# or
ENGRAM_STUB_PORT=5000 node scripts/engram-stub.mjs
```

### Integration Test

```bash
node scripts/test-engram-integration.mjs
```

### Benchmarks

```bash
# Baseline (before changes)
node scripts/benchmark-baseline.mjs

# Post-implementation (after changes)
node scripts/benchmark-post-implementation.mjs

# Real MCP path (in-process ToolHandler, not CLI+cURL)
node scripts/benchmark-mcp-memory.mjs
```

## Implementation Details

### Files

- `src/integrations/engram-sync.ts` — Insight extractor + Engram HTTP client
- `src/mcp/tools.ts` — `explore_with_memory` MCP tool
- `src/index.ts` — Post-index hook + `syncInsightsToEngram()` method
- `scripts/engram-stub.mjs` — Development stub server
- `scripts/test-engram-integration.mjs` — Integration test
- `scripts/benchmark-baseline.mjs` — Baseline benchmark
- `scripts/benchmark-post-implementation.mjs` — Post-implementation benchmark

### Post-Index Hook

The hook is non-blocking (fire-and-forget) and never fails the sync:

```typescript
// In sync() and indexAll()
if (process.env.CODEGRAPH_ENGRAM_ENABLED === '1') {
  this.syncInsightsToEngram().catch(() => { /* never fail sync over Engram */ });
}
```

### Graceful Degradation

If Engram is unavailable:
- `explore_with_memory` returns normal explore results
- Post-index sync logs the error but doesn't fail
- All functionality works without Engram

## Future Work

- [ ] Bi-directional sync (Engram → CodeGraph context)
- [ ] Real-time sync via Engram MCP
- [ ] Configurable insight thresholds
- [ ] Insight quality scoring
- [ ] Memory decay (forget unused insights)
