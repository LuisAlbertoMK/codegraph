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

### Deduplication

Each insight carries a `deduplication_key`:
```
codegraph:{project}:{qualified_name}
```

Re-indexing updates existing observations instead of duplicating them.
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
| `memory.search` | query, the terms actually sent (stopwords stripped), limit, project, `ok`/`status`/`error`, `count`, `ms` |
| `tool.memory_search` | the MCP call: `count`, `ms` |
| `tool.explore_with_memory` | `exploreMs`, `memoryMs`, `totalMs`, `count`, `injected`, injected/explore chars |
| `extract.done` | nodes scanned, caller candidates, scored pool, insights produced, `ms` |
| `sync.start` | insights offered vs posted, skipped (hash unchanged), state entries, `stateMs` |
| `sync.session`, `sync.post` | per-request `status`/`attempts`/`pid`/`ms`, keyed by insight |
| `sync.done` | `created`/`updated`/`failed`/`skipped`/`retried` plus `sessionMs`, `postMs`, `revisionMs`, `ms` |
| `hook.sync` | the post-index hook: `trigger` (`index`/`sync`), totals, `ms` |

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
- Insight sync: ~2.5s for 30 insights on a 10k-file repo (batched impact walks, non-blocking fire-and-forget)

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

### Retries

A transient failure is retried within the SAME `ENGRAM_TIMEOUT_MS` window — a dropped connection, a server error (5xx), or rate limiting (429). The per-attempt timeout is capped by what is left of the window, so retrying can never make a dead Engram slower: a hung server still issues exactly one request and gives up at `ENGRAM_TIMEOUT_MS`. A 4xx is never retried (the same request fails the same way). Repeated POSTs are safe because Engram upserts on the insight's deduplication key. Tune with `ENGRAM_RETRY_ATTEMPTS` (default 3, backoff 100ms→500ms with full jitter).

## Future Work

- [ ] Bi-directional sync (Engram → CodeGraph context)
- [ ] Real-time sync via Engram MCP
- [ ] Configurable insight thresholds
- [ ] Insight quality scoring
- [ ] Memory decay (forget unused insights)
