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
export ENGRAM_TIMEOUT_MS=10000  # Engram HTTP timeout in ms (default: 10000) — also the retry budget
export ENGRAM_RETRY_ATTEMPTS=3  # total attempts per request (default: 3; 1 disables retrying)
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
its own cache entry, keeping fresh strict matches discoverable. The per-term
fetches run in parallel and merge preferring rows that match more of the
query (then strongest-match-first, following the server's own ranking:
more negative rank wins), so a row only a later term matches is never
starved by an earlier term's hits.

**Accents:** Engram indexes `decisión` and `decision` as different words
(measured: `integración` answers 5 rows, `integracion` answers 0), and its
`/search` takes no query syntax — no `OR`, no quoting, no wildcards. The
strict query is one AND over the terms as written, so it adds nothing here; the
per-term fallback asks for an accented term twice, as written and folded, and
counts the two spellings as one query term when ranking. The spellings it sent
are recorded as `variants` in the trace. That covers an accented query reaching
a plainly spelled memory; an unaccented query still cannot reach an accented
memory, which needs folding at index time on the server.

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

## Diagnostics (trace)

Every memory search, insight extraction, sync attempt and memory-aware tool call appends one JSON line to a bounded trace:

```
<project>/.codegraph/engram-debug.jsonl      # rotated to .1 at 1 MiB, one previous generation kept
```

This exists because the integration degrades silently by design: a slow, dead, or empty Engram all look the same from the tool output ("no matching memory"). The trace is what tells them apart after the fact, without a server to query.

```bash
# failures only — a memory search that never reached Engram
rg '"event":"memory.search","project":"x".*"ok":false' .codegraph/engram-debug.jsonl

# where a slow explore actually spent its time
rg '"event":"tool.explore_with_memory"' .codegraph/engram-debug.jsonl | tail -1
```

Each line carries `ts`, `pid`, `event` and, wherever the caller can time it, `ms`. `pid` matters: a tool call can be answered by the session's own MCP process or by the shared background daemon, and which one it was decides which build (and which `CODEGRAPH_*` env) produced the numbers.

| event | what it records |
|---|---|
| `memory.search` | query, the terms actually sent (stopwords stripped), `variants` (every spelling a per-word fallback asked for, so a folded retry is visible; empty when the fallback asked nothing, absent when it answered from cache), limit, project, `ok`/`status`/`error`, `count`, `ms` |
| `memory.fetch` | a search request that did NOT answer 2xx (`status`, terms) — what separates "Engram said no" from "Engram is unreachable" |
| `tool.memory_search` | the MCP call: `count`, `ms` |
| `tool.explore_with_memory` | `exploreMs`, `memoryMs`, `totalMs`, `count`, `injected`, injected/explore chars |
| `extract.done` | nodes scanned, caller candidates, scored pool, insights produced, `ms` |
| `sync.start` | insights offered vs posted, skipped (hash unchanged), state entries, `stateMs` |
| `sync.session`, `sync.post` | per-request `status`/`attempts`/`pid`/`ms`, keyed by insight |
| `sync.done` | `created`/`updated`/`failed`/`skipped`/`retried` plus `sessionMs`, `postMs`, `ms` |
| `hook.sync` | the post-index hook: `trigger` (`index`/`sync`/`manual`), totals, `ms` |

Knobs:

```bash
export CODEGRAPH_ENGRAM_DEBUG=0                 # turn the trace off (default: on)
export CODEGRAPH_ENGRAM_DEBUG_FILE=/tmp/x.jsonl # write somewhere else (default: per-project)
export CODEGRAPH_ENGRAM_DEBUG_MAX_BYTES=1048576 # rotation threshold (default: 1 MiB)
```

The trace never throws: a full disk, a locked file or a missing directory must not break indexing or a tool call. It also never leaves the machine — no network, no telemetry.

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
- `src/integrations/engram-log.ts` — Bounded JSONL diagnostics trace (`engram-debug.jsonl`)
- `src/mcp/tools.ts` — `explore_with_memory` MCP tool
- `src/index.ts` — Post-index hook + `syncInsightsToEngram()` method
- `scripts/engram-stub.mjs` — Development stub server
- `scripts/test-engram-integration.mjs` — Integration test
- `scripts/benchmark-baseline.mjs` — Baseline benchmark
- `scripts/benchmark-post-implementation.mjs` — Post-implementation benchmark

### Post-Index Hook

The hook is non-blocking (fire-and-forget) and never fails the sync:

```typescript
// In indexAll() and sync() — the trigger is passed through to the trace
if (process.env.CODEGRAPH_ENGRAM_ENABLED === '1') {
  this.syncInsightsToEngram('index').catch(() => { /* never fail index over Engram */ });
}
```

### Graceful Degradation

If Engram is unavailable:
- `explore_with_memory` returns normal explore results
- Post-index sync logs the error but doesn't fail
- All functionality works without Engram

### Retries

A transient failure is retried within the SAME `ENGRAM_TIMEOUT_MS` window — a dropped connection, a server error (5xx), or rate limiting (429). The per-attempt timeout is capped by what is left of the window, so retrying can never make a dead Engram slower: a hung server still issues exactly one request and gives up at `ENGRAM_TIMEOUT_MS`. A 4xx is never retried (the same request fails the same way). Repeated POSTs are safe because Engram upserts on the insight's deduplication key. Tune with `ENGRAM_RETRY_ATTEMPTS` (default 3, backoff 100ms→500ms with full jitter). A POST that needed more than one attempt is counted in the sync result's `retried`, so a reader of the created/updated split knows it may have drifted (the server may already have processed the attempt that timed out; the data is still one observation, upserted).

## Future Work

- [ ] Bi-directional sync (Engram → CodeGraph context)
- [ ] Real-time sync via Engram MCP
- [ ] Configurable insight thresholds
- [ ] Insight quality scoring
- [ ] Memory decay (forget unused insights)
