/**
 * Engram Sync — Insight Extractor
 *
 * Extracts key insights from the CodeGraph knowledge graph and persists
 * them to Engram (persistent memory) for cross-session recall.
 *
 * Insights are extracted post-index/sync and include:
 * - Top symbols by caller count (most depended-upon code)
 * - High-impact symbols (large blast radius)
 * - Key flows (explore results for central symbols)
 *
 * Deduplication: each insight carries a `deduplication_key` so re-indexing
 * updates existing observations instead of duplicating them.
 */

import type CodeGraph from '../index';
import type { Node } from '../types';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describeError, elapsedMs, logEngram, startTimer } from './engram-log';

// ============================================================================
// Project identity
// ============================================================================

/** Memoized results of {@link deriveEngramProject} — one entry per root. */
const projectNameCache = new Map<string, string>();

/**
 * Bound on {@link projectNameCache}: a long-lived daemon can be pointed at many
 * projects (`projectPath` per call), and an unbounded map would make every one
 * of them a permanent allocation.
 */
const PROJECT_CACHE_MAX = 32;

/**
 * The Engram project name for a directory, derived the way Engram derives it:
 * `ENGRAM_PROJECT` when pinned, else the `origin` remote's repository name,
 * else the directory basename.
 *
 * Matching Engram matters more than picking a good name. The agent's own
 * memories of this repo live under Engram's name, and every codegraph memory
 * read and write filters by ours, so a mismatch splits one repository across
 * two projects: a clone in another folder (`work/`, a fork, a worktree) filed
 * codegraph's insights apart from the decisions the agent had saved, and
 * `explore_with_memory` saw only half of what it had written.
 *
 * Verified against Engram 3.5.2: a repo whose `origin` is `acme/remote-name`
 * checked out as `local-dir-name` is stored under `remote-name`; a directory
 * with no git remote (or no `origin`, only `upstream`) uses its basename. The
 * git lookup is memoized and never throws: a missing binary, a non-repo, or a
 * timeout falls back to the basename.
 */
export function deriveEngramProject(rootDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env.ENGRAM_PROJECT?.trim();
  if (pinned) return pinned;

  const cached = projectNameCache.get(rootDir);
  if (cached) return cached;

  const fallback = rootDir.split(/[\\/]/).filter(Boolean).pop() || 'unknown';
  const project = projectNameFromRemote(readOriginUrl(rootDir)) ?? fallback;
  if (projectNameCache.size >= PROJECT_CACHE_MAX) {
    const oldest = projectNameCache.keys().next().value;
    if (oldest !== undefined) projectNameCache.delete(oldest);
  }
  projectNameCache.set(rootDir, project);
  return project;
}

/**
 * Repository name from a git remote URL, in every form git accepts:
 * `https://host/group/repo.git`, `git@host:group/repo.git`, `ssh://host/repo`,
 * a local path, with or without a trailing slash.
 */
export function projectNameFromRemote(url: string | null | undefined): string | null {
  const cleaned = url?.trim().replace(/[\\/]+$/, '');
  if (!cleaned) return null;
  const last = cleaned.split(/[/\\:]/).filter(Boolean).pop();
  if (!last) return null;
  const name = last.replace(/\.git$/i, '');
  return name || null;
}

/** `origin`'s URL for `rootDir`, or null (no git, no remote, git missing). */
function readOriginUrl(rootDir: string): string | null {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Is the sync state file tracked by git?
 *
 * `.codegraph/` is gitignored, so a state file git knows about was force-added:
 * it is repository content, and repository content is not trusted input. Every
 * entry that reaches the prune path becomes a DELETE for that observation id,
 * so a committed state file is a way to have a cloned repo delete memory. When
 * this returns true the state is ignored and the next sync rebuilds it from ids
 * this machine actually wrote.
 *
 * Positive evidence only: no git binary, not a repository, or a timeout all
 * report `false` and keep the previous behavior.
 */
function stateFileIsTracked(rootDir: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', '.codegraph/engram-sync-state.json'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Memory Cache (session-level, avoids repeated Engram calls for same query)
// ============================================================================

interface CacheEntry<T> {
  results: T;
  timestamp: number;
}

/**
 * Simple in-memory cache for Engram search results.
 * - Key: backend URL + project + normalized query + limit. A key without
 *   the URL serves one backend's rows for another and masks outages.
 * - TTL: 60 seconds (balances freshness vs. performance)
 * - Auto-expires: entries older than TTL are ignored
 * - Bounded: at most {@link MEMORY_CACHE_MAX_ENTRIES} answers, oldest first
 * - Session-only: cleared when process exits (or via clearMemoryCache)
 */
const MEMORY_CACHE_TTL_MS = 60_000;

/**
 * Hard bound on cached answers. One key is one distinct
 * (backend, project, query, limit) question, and the MCP daemon outlives any
 * single session — unbounded, it would accumulate every question ever asked,
 * each holding the full content of its observations. TTL alone does not bound
 * it: an entry is only dropped when its own key is looked up again, so
 * questions asked once and never repeated would never be evicted.
 */
export const MEMORY_CACHE_MAX_ENTRIES = 200;

const memoryCache = new Map<string, CacheEntry<Array<{ title: string; content: string; score: number; type: string }>>>();

function getCacheKey(project: string | undefined, query: string, engramUrl: string, limit: number): string {
  return `${engramUrl}\n${project || 'all'}:${query.toLowerCase().trim()}:${limit}`;
}

/**
 * Drop all cached Engram search results. Tests call this to isolate cases
 * that reuse a project/query against different backends.
 */
export function clearMemoryCache(): void {
  memoryCache.clear();
}

function getCachedResults(key: string): Array<{ title: string; content: string; score: number; type: string }> | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > MEMORY_CACHE_TTL_MS) {
    memoryCache.delete(key);
    return null;
  }
  // Refresh recency on a hit: a question that keeps being asked must not be
  // evicted ahead of one that was asked once and never revisited. Map iterates
  // in insertion order, so re-inserting moves this entry to the newest end.
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.results;
}

function setCachedResults(key: string, results: Array<{ title: string; content: string; score: number; type: string }>): void {
  const now = Date.now();
  // Re-inserting moves the key to the newest end: a question asked again is
  // hot, and must not be evicted ahead of one asked once long ago.
  memoryCache.delete(key);
  memoryCache.set(key, { results, timestamp: now });

  if (memoryCache.size <= MEMORY_CACHE_MAX_ENTRIES) return;

  // Expired answers are dead weight — drop them before evicting a live one.
  for (const [cachedKey, entry] of memoryCache) {
    if (memoryCache.size <= MEMORY_CACHE_MAX_ENTRIES) break;
    if (now - entry.timestamp > MEMORY_CACHE_TTL_MS) memoryCache.delete(cachedKey);
  }

  // Map iterates in insertion order, so the front is the least recently seen.
  while (memoryCache.size > MEMORY_CACHE_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next();
    if (oldest.done) break;
    memoryCache.delete(oldest.value);
  }
}

// ============================================================================
// Types
// ============================================================================

export interface CodeGraphInsight {
  /** Unique identifier for deduplication: codegraph:{project}:{qualifiedName} */
  deduplication_key: string;
  /** Human-readable title */
  title: string;
  /** Structured content for Engram */
  content: string;
  /**
   * Insight kind, passed through to Engram as the observation's type.
   *
   * Only these two are emitted. A design-pattern or architecture insight would
   * have to be guessed heuristically, and an unvalidated guess in project
   * memory is worse than its absence — so the union no longer promises
   * `pattern`/`architecture`, which nothing ever produced.
   */
  type: 'symbol' | 'flow';
  /** Project name (from cwd or explicit) */
  project: string;
  /** Symbol name */
  name: string;
  /** Qualified name (Class.method) */
  qualifiedName: string;
  /** Source file path */
  filePath: string;
  /** Start line in source */
  startLine: number;
  /** Number of callers (direct + indirect) */
  callerCount: number;
  /** Impact radius (nodes affected if this changes) */
  impactCount: number;
  /** Top callers (names only, for context) */
  topCallers: string[];
  /** Top impacted nodes (names only) */
  topImpacted: string[];
  /** Confidence score 0-1 */
  confidence: number;
  /** Topic key for Engram organization */
  topic_key: string;
}

export interface ExtractOptions {
  /** Maximum number of insights to extract (default: 30) */
  maxInsights?: number;
  /** Minimum caller count to include (default: 3) */
  minCallers?: number;
  /** Minimum impact radius to include (default: 5) */
  minImpact?: number;
  /** Project name (default: derived from cwd) */
  project?: string;
  /** Whether to include flow insights (default: true) */
  includeFlows?: boolean;
}

/** The three numbers that decide which symbols become memory. */
export type InsightLimits = Required<Pick<ExtractOptions, 'maxInsights' | 'minCallers' | 'minImpact'>>;

/**
 * Default selection limits: a symbol earns a memory when at least 3 places
 * call it and it reaches 5 nodes within two hops.
 *
 * These are a starting point, not a law — the extraction cost is one depth-2
 * walk per candidate, so the numbers trade memory size against extraction
 * time, and what counts as "worth remembering" differs by repo shape. A small
 * service where the top function has two callers produces NOTHING at the
 * defaults and should lower them; a huge repo should raise `minCallers`
 * rather than pay for a list of near-leaf helpers. Override through
 * {@link readInsightLimitsFromEnv}.
 */
export const DEFAULT_INSIGHT_LIMITS: InsightLimits = { maxInsights: 30, minCallers: 3, minImpact: 5 };

/**
 * Upper bound on `maxInsights`, independent of what the environment asks for.
 * Each candidate costs an impact walk, so an unbounded value turns one sync
 * into a graph scan; 200 is well past any project whose top symbols are all
 * worth recalling.
 */
const MAX_INSIGHTS_CEILING = 200;

/**
 * Selection limits from the environment, falling back per value.
 *
 * An unset, non-numeric, or out-of-range value falls back to the default
 * instead of throwing: this runs inside the post-index hook, where a typo in
 * an env var must not cost the user their index. `maxInsights` is clamped to
 * {@link MAX_INSIGHTS_CEILING}; the thresholds are clamped only at 0, which is
 * a legitimate "no bar" (every symbol, up to `maxInsights`).
 */
export function readInsightLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InsightLimits {
  const read = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) return fallback;
    return Math.min(value, max);
  };
  return {
    maxInsights: read('CODEGRAPH_ENGRAM_MAX_INSIGHTS', DEFAULT_INSIGHT_LIMITS.maxInsights, 1, MAX_INSIGHTS_CEILING),
    minCallers: read('CODEGRAPH_ENGRAM_MIN_CALLERS', DEFAULT_INSIGHT_LIMITS.minCallers, 0, 1_000),
    minImpact: read('CODEGRAPH_ENGRAM_MIN_IMPACT', DEFAULT_INSIGHT_LIMITS.minImpact, 0, 100_000),
  };
}

// ============================================================================
// Insight Extraction
// ============================================================================

/**
 * Extract insights from a CodeGraph instance.
 *
 * Strategy:
 * 1. Get all function/method/class nodes
 * 2. For each, count callers (direct edges)
 * 3. Filter by minCallers/minImpact thresholds
 * 4. Sort by impact * callers (centrality score)
 * 5. Take top N
 * 6. Enrich with top callers/impacted names
 */
export async function extractInsights(
  graph: CodeGraph,
  options: ExtractOptions = {}
): Promise<CodeGraphInsight[]> {
  const {
    maxInsights = DEFAULT_INSIGHT_LIMITS.maxInsights,
    minCallers = DEFAULT_INSIGHT_LIMITS.minCallers,
    minImpact = DEFAULT_INSIGHT_LIMITS.minImpact,
    project = process.cwd().split(/[\\/]/).pop() || 'unknown',
    includeFlows = true,
  } = options;

  // All code-bearing nodes in one IN query instead of four scans. The rows
  // come back interleaved rather than grouped by kind, but stage 1 sorts
  // deterministically below, so the order changes nothing downstream.
  const allNodes = graph.getNodesByKinds(['function', 'method', 'class', 'interface']);

  // Two-stage ranking: a caller lookup is cheap (~0.15ms) while the depth-2
  // impact walk is ~10x costlier and dominates extraction on large repos.
  // Rank by callers first, then score centrality only for a generous candidate
  // pool. Validated on a 12k-node repo: top-30-by-score sits inside
  // top-50-by-callers (overlap probe), so IMPACT_POOL = 100 keeps 2x margin.
  // The pool always covers maxInsights so a large maxInsights can't clip it.
  const IMPACT_POOL = 100;
  const poolSize = Math.max(IMPACT_POOL, maxInsights);

  // Stage 1 is a SINGLE grouped scan (12k round trips -> 1): caller fan-in
  // per target, identical numbers to getCallers(id, 1).length.
  const callerCounts = graph.getCallerCounts();
  const byCallers: Array<{ node: Node; callerCount: number }> = [];
  for (const node of allNodes) {
    const callerCount = callerCounts.get(node.id) ?? 0;
    if (callerCount < minCallers) continue;
    byCallers.push({ node, callerCount });
  }
  // Deterministic order: score ties break by identity, never by DB row order
  // (getNodesByKind has no ORDER BY — tie order would flip run to run).
  const byIdentity = (a: Node, b: Node): number =>
    a.qualifiedName < b.qualifiedName ? -1
    : a.qualifiedName > b.qualifiedName ? 1
    : a.filePath < b.filePath ? -1
    : a.filePath > b.filePath ? 1 : 0;
  byCallers.sort((a, b) => b.callerCount - a.callerCount || byIdentity(a.node, b.node));

  // Score centrality for the pool only. Batched membership: one handful of
  // round trips per node instead of one per walk step (~3.2x measured).
  // The impact set travels with the score: the build step below reuses it
  // instead of re-walking the same nodes (the walk dominates extraction).
  const scored: Array<{ node: Node; callerCount: number; impactCount: number; impactIds: Set<string>; score: number }> = [];
  for (const { node, callerCount } of byCallers.slice(0, poolSize)) {
    const impactIds = graph.getImpactIdsBatched(node.id, 2);
    const impactCount = impactIds.size;
    if (impactCount < minImpact) continue;
    const score = callerCount * Math.log(impactCount + 1);
    scored.push({ node, callerCount, impactCount, impactIds, score });
  }

  // Sort by score descending (identity tie-break — see above)
  scored.sort((a, b) => b.score - a.score || byIdentity(a.node, b.node));

  // Take top N
  const top = scored.slice(0, maxInsights);

  // Build insights
  const insights: CodeGraphInsight[] = [];

  // Deduplication keys include the file: qualifiedName alone collides
  // across definitions (two `Node` interfaces in different files share one
  // key and clobber each other on every sync). filePath+name is stable
  // across re-indexes (raw node ids are not — never key on those).
  for (const { node, callerCount, impactCount, impactIds } of top) {
    // Caller names only for the final top-N — one cheap lookup each.
    // Impacted names reuse the scoring walk above (same Set object, so the
    // sample order is identical to re-walking) + a 5-row fetch. First-5 via
    // iterator: a hub's depth-2 set can hold thousands of ids and only 5 are
    // kept — spreading it all just to slice is pure garbage. The focal id
    // leads the set (platform convention: impact includes self, same as
    // explore/viewer counts) but is skipped here: it is not an "impacted"
    // neighbor, and its own name would pollute the searchable text.
    const callers = graph.getCallers(node.id, 1);
    const impactSample: string[] = [];
    for (const id of impactIds) {
      if (id === node.id) continue;
      if (impactSample.length >= 5) break;
      impactSample.push(id);
    }
    const impactNodes = impactSample.length > 0 ? graph.getNodesByIds(impactSample) : new Map<string, Node>();
    const topCallers = callers
      .slice(0, 5)
      .map(c => c.node.name);

    const topImpacted = impactSample.map((id) => impactNodes.get(id)?.name ?? id);

    const confidence = Math.min(1, (callerCount / 20) + (impactCount / 50));

    const insight: CodeGraphInsight = {
      deduplication_key: `codegraph:${project}:${node.filePath}:${node.qualifiedName}`,
      title: `${node.qualifiedName} — ${callerCount} callers, ${impactCount} impacted`,
      content: buildInsightContent(node, callerCount, impactCount, topCallers, topImpacted),
      type: 'symbol',
      project,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      startLine: node.startLine,
      callerCount,
      impactCount,
      topCallers,
      topImpacted,
      confidence,
      topic_key: `codegraph:${project}`,
    };

    insights.push(insight);
  }

  // Optionally add flow insights for top symbols (nodes travel with their
  // insights so flows bind the exact symbol, never a same-named lookalike)
  if (includeFlows && insights.length > 0) {
    const flowInputs: Array<{ insight: CodeGraphInsight; node: Node }> = [];
    for (let i = 0; i < Math.min(5, top.length, insights.length); i++) {
      const insight = insights[i];
      const entry = top[i];
      if (insight !== undefined && entry !== undefined) flowInputs.push({ insight, node: entry.node });
    }
    const flowInsights = await extractFlowInsights(graph, flowInputs, project);
    // `maxInsights` is the size of the whole list, flows included. They share
    // the budget instead of riding on top of it (they used to: a run capped at
    // 30 posted up to 35). Flows come first because they are the part worth
    // most when the budget is tiny; the symbols they were built from are the
    // ones dropped, since the flow carries the same identity.
    const flowBudget = Math.min(flowInsights.length, maxInsights);
    const symbolBudget = Math.max(0, maxInsights - flowBudget);
    return [...insights.slice(0, symbolBudget), ...flowInsights.slice(0, flowBudget)];
  }

  return insights;
}

/**
 * Build human-readable content for an insight.
 */
function buildInsightContent(
  node: Node,
  callerCount: number,
  impactCount: number,
  topCallers: string[],
  topImpacted: string[]
): string {
  const parts: string[] = [];

  parts.push(`Symbol: ${node.qualifiedName}`);
  parts.push(`File: ${node.filePath}:${node.startLine}`);
  parts.push(`Callers: ${callerCount} (${topCallers.join(', ')})`);
  parts.push(`Impact: ${impactCount} nodes affected`);
  parts.push(`Top impacted: ${topImpacted.join(', ')}`);

  if (node.signature) {
    parts.push(`Signature: ${node.signature}`);
  }

  if (node.docstring) {
    parts.push(`Docs: ${node.docstring.slice(0, 200)}`);
  }

  return parts.join('\n');
}

/**
 * Extract flow insights for top symbols.
 *
 * A flow insight captures the call path through a central symbol,
 * giving the agent a "how does X work" summary.
 */
async function extractFlowInsights(
  graph: CodeGraph,
  topInsights: Array<{ insight: CodeGraphInsight; node: Node }>,
  project: string
): Promise<CodeGraphInsight[]> {
  const flows: CodeGraphInsight[] = [];

  for (const { insight, node } of topInsights) {
    // Callees of the exact node — never re-resolve by short name (overloads
    // and common names would bind another symbol's callees to this insight).
    const callees = graph.getCallees(node.id, 1);
    if (callees.length === 0) continue;

    const calleeNames = callees.slice(0, 5).map(c => c.node.name);

    flows.push({
      deduplication_key: `codegraph:${project}:flow:${insight.filePath}:${insight.qualifiedName}`,
      title: `Flow: ${insight.qualifiedName} → ${calleeNames.join(', ')}`,
      content: [
        `Flow through ${insight.qualifiedName}:`,
        `Calls: ${calleeNames.join(', ')}`,
        `Called by: ${insight.topCallers.join(', ')}`,
        `Impact radius: ${insight.impactCount} nodes`,
      ].join('\n'),
      type: 'flow',
      project,
      name: insight.name,
      qualifiedName: insight.qualifiedName,
      filePath: insight.filePath,
      startLine: insight.startLine,
      callerCount: insight.callerCount,
      impactCount: insight.impactCount,
      topCallers: insight.topCallers,
      topImpacted: calleeNames,
      confidence: insight.confidence * 0.8,
      topic_key: `codegraph:${project}`,
    });
  }

  return flows;
}

// ============================================================================
// Sync to Engram
// ============================================================================

/**
 * Deterministic per-project sync session id. Stable across runs so insights
 * accumulate in one session instead of spawning a session per sync.
 * Server-side session creation is idempotent.
 */
function syncSessionIdFor(project: string): string {
  let h = 0;
  for (const ch of `codegraph:${project}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `ses_cg_sync_${Math.abs(h).toString(36).padStart(7, '0')}`;
}

async function ensureSyncSession(engramUrl: string, project: string, rootDir?: string): Promise<string> {
  const sessionId = syncSessionIdFor(project);
  const startedAt = startTimer();
  try {
    const response = await fetchWithRetry(`${engramUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, project }),
    });
    logEngram('sync.session', { project, ok: response.ok, status: response.status, ms: elapsedMs(startedAt) }, rootDir);
  } catch (err) {
    // best-effort; saves surface failures with counts. The trace keeps the reason.
    logEngram('sync.session', { project, ok: false, error: describeError(err), ms: elapsedMs(startedAt) }, rootDir);
  }
  return sessionId;
}

/**
 * Hard ceiling on one Engram request. The point of the timeout is that a hung
 * server cannot hold the post-index chain; a value large enough to do that is
 * the same failure the timeout exists to prevent, so it is clamped instead of
 * obeyed.
 */
export const ENGRAM_TIMEOUT_CEILING_MS = 60_000;

/**
 * Engram HTTP timeout (ms) from the environment. A hung Engram (socket
 * accepted, never responds) must never stall the fire-and-forget post-index
 * chain — it only delays background memory, never indexing. Unset, non-numeric,
 * or non-positive falls back to 10s; anything larger than
 * {@link ENGRAM_TIMEOUT_CEILING_MS} is clamped.
 */
export function readEngramTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.ENGRAM_TIMEOUT_MS || '10000', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 10_000;
  return Math.min(raw, ENGRAM_TIMEOUT_CEILING_MS);
}

function getEngramTimeoutMs(): number {
  return readEngramTimeoutMs();
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
  const ms = timeoutMs ?? getEngramTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    // Redirects are refused, not followed. Engram is an unauthenticated
    // loopback server, and a 3xx is the only way a request aimed at 127.0.0.1
    // (search text, insights, memory ids) can be re-sent to a host off this
    // machine; following one silently would make that exfiltration free.
    return await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Total attempts per Engram request (first try + retries). Override with
 * ENGRAM_RETRY_ATTEMPTS; 1 disables retrying.
 */
function getEngramRetryAttempts(): number {
  const raw = parseInt(process.env.ENGRAM_RETRY_ATTEMPTS || '3', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/**
 * Worth retrying? The server's own failure (5xx) or rate limiting (429).
 * A 4xx is a client error — the same request fails the same way, so it is
 * handed back to the caller untouched instead of burning the budget.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

const RETRY_BASE_DELAY_MS = 100;
const RETRY_MAX_DELAY_MS = 500;

/** Full jitter under the exponential ceiling — the 8 sync lanes must not retry in lockstep. */
function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
  return Math.round(Math.random() * ceiling);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch with bounded retries that spend ONE `ENGRAM_TIMEOUT_MS` window in
 * total, never more. The per-attempt timeout is capped by what is LEFT of the
 * window, so a hung Engram still gives up exactly when a single un-retried
 * attempt did — retrying a flaky Engram adds resilience without ever making a
 * dead one slower (a hung server still sees exactly one request).
 *
 * `init` is REPLAYED on every attempt. That is only safe because every caller
 * sends a `JSON.stringify(...)` string body; a stream or `FormData` body would
 * already be consumed by the failed attempt and must not be retried this way.
 *
 * The POSTs are safe to repeat: Engram upserts on `deduplication_key`, so a
 * retry after a timeout that the server actually processed updates the same
 * observation instead of creating a second one.
 *
 * `onRetry`, when given, fires once per retry (before the delay) so a caller
 * can report that its request took more than one attempt.
 *
 * The final attempt's response or error is returned/thrown unchanged, so every
 * caller keeps its existing `!response.ok` and try/catch handling.
 */
async function fetchWithRetry(url: string, init: RequestInit = {}, onRetry?: () => void): Promise<Response> {
  const attempts = getEngramRetryAttempts();
  const budgetMs = getEngramTimeoutMs();
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 1; ; attempt++) {
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) break;

    try {
      const response = await fetchWithTimeout(url, init, remaining);
      if (!isRetryableStatus(response.status)) return response;
      lastError = new Error(`Engram responded ${response.status}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt >= attempts) break;
    const delay = retryDelayMs(attempt);
    if (Date.now() - startedAt + delay >= budgetMs) break; // no room for another try
    onRetry?.();
    await sleep(delay);
  }

  throw lastError ?? new Error('Engram request failed');
}

/**
 * Bounded-parallel map: runs fn over items with at most `limit` in flight,
 * preserving input order in the output. The Engram server answers each call
 * in ~30ms, so 30 sequential round trips dominate sync time (~2s); 8 lanes
 * cut it to a few waves (~0.3s) without hammering its SQLite writer.
 */
const SYNC_CONCURRENCY = 8;

/** Per-run cap on deletions — see {@link pruneStaleInsights}. */
const PRUNE_MAX_PER_RUN = 200;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const wave = items.slice(i, i + limit);
    const results = await Promise.all(wave.map((item, j) => fn(item, i + j)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r !== undefined) out[i + j] = r;
    }
  }
  return out;
}

/**
 * Delete the observations of insights whose symbol no longer exists.
 *
 * Only entries carrying an identity can be checked (state v3+); older entries
 * are left alone rather than guessed at. The caller supplies `stillExists`
 * because only the graph owner can tell "the symbol is gone" from "it is not
 * in this run's top N" — omitting it disables pruning entirely, so an
 * unindexed root can never wipe a project's memory.
 *
 * The delete is Engram's soft delete, so a wrong prune stays recoverable.
 *
 * `project` must be one the caller declared (option or insight). A guessed
 * name is a delete target: when nobody says which project this is, the safe
 * move is to delete nothing.
 */
async function pruneStaleInsights(
  state: Map<string, SyncStateEntry>,
  stillExists: ((filePath: string, qualifiedName: string) => boolean) | undefined,
  engramUrl: string,
  project: string | undefined,
  traceRoot?: string,
): Promise<{ pruned: number; pruneFailed: number }> {
  if (!stillExists) return { pruned: 0, pruneFailed: 0 };
  if (!project) {
    logEngram('sync.prune', { skipped: 'no-project' }, traceRoot);
    return { pruned: 0, pruneFailed: 0 };
  }

  const stale: Array<[string, SyncStateEntry]> = [];
  for (const [key, entry] of state) {
    if (!entry.filePath || !entry.qualifiedName) continue;
    if (stillExists(entry.filePath, entry.qualifiedName)) continue;
    stale.push([key, entry]);
  }
  if (stale.length === 0) return { pruned: 0, pruneFailed: 0 };

  // Bounded so a large rename sweep cannot turn one sync into an unbounded
  // burst of deletes; the next sync continues where this one stopped.
  const batch = stale.slice(0, PRUNE_MAX_PER_RUN);
  const outcomes = await mapWithConcurrency(batch, SYNC_CONCURRENCY, async ([key, entry]) => {
    const itemStartedAt = startTimer();
    try {
      const response = await fetchWithRetry(
        `${engramUrl}/observations/${encodeURIComponent(String(entry.id))}?expected_project=${encodeURIComponent(project)}`,
        { method: 'DELETE' },
      );
      // 404 is the desired end state: already gone (deleted by hand, or a
      // previous run whose state write did not land).
      if (!response.ok && response.status !== 404) {
        logEngram('sync.prune', { key, ok: false, status: response.status, ms: elapsedMs(itemStartedAt) }, traceRoot);
        return false;
      }
      state.delete(key);
      logEngram('sync.prune', { key, ok: true, status: response.status, ms: elapsedMs(itemStartedAt) }, traceRoot);
      return true;
    } catch (err) {
      logEngram('sync.prune', { key, ok: false, error: describeError(err), ms: elapsedMs(itemStartedAt) }, traceRoot);
      return false;
    }
  });

  const pruned = outcomes.filter((ok) => ok).length;
  const pruneFailed = outcomes.length - pruned;
  if (pruned > 0) saveSyncState(traceRoot, state, true);
  return { pruned, pruneFailed };
}

/**
 * Sync insights to Engram via HTTP.
 *
 * Uses the Engram HTTP API (POST /observations) with deduplication.
 * Failures are logged but never throw — insight sync must not break indexing.
 *
 * `options.stillExists` is the caller's view of the current graph. With it, a
 * previously synced insight whose symbol is gone gets its observation deleted
 * (soft delete — Engram keeps it recoverable) instead of lingering as memory
 * about code that no longer exists. Without it nothing is pruned.
 */
export async function syncInsightsToEngram(
  insights: CodeGraphInsight[],
  engramUrl: string = process.env.ENGRAM_URL || 'http://127.0.0.1:7437',
  options: {
    rootDir?: string;
    stillExists?: (filePath: string, qualifiedName: string) => boolean;
    project?: string;
  } = {}
): Promise<{ created: number; updated: number; failed: number; skipped: number; retried: number; pruned: number; pruneFailed: number }> {
  const result = { created: 0, updated: 0, failed: 0, skipped: 0, retried: 0, pruned: 0, pruneFailed: 0 };

  // Called with an empty insight list (an index that produced none) the prune
  // still runs: symbols that vanished are exactly the reason a run can be
  // empty, and the live set is what gates it, not the insight count.
  //
  // Posting keeps the 'codegraph' fallback for library callers that never set
  // a project; pruning does not — it takes its target from a declared name or
  // not at all (see pruneStaleInsights).
  const declaredProject = options.project ?? insights[0]?.project;
  const project = declaredProject ?? 'codegraph';
  const traceRoot = options.rootDir;
  const startedAt = startTimer();

  // Incremental sync: insights whose content hash matches local state skip
  // the network entirely. State v3 stores {id, hash, filePath, qualifiedName}
  // per key; v2 (no identity) still syncs, it just cannot be pruned. State
  // lives in .codegraph/ (gitignored, per-project). Typical syncs post 0-3
  // changed insights.
  const state = loadSyncState(options.rootDir);

  // Prune before the early returns: a repo whose insights never change is
  // exactly the steady state where stale ones would otherwise sit forever.
  Object.assign(
    result,
    await pruneStaleInsights(state, options.stillExists, engramUrl, declaredProject, traceRoot),
  );

  if (insights.length === 0) {
    logEngram('sync.done', { project, ...result, ms: elapsedMs(startedAt) }, traceRoot);
    return result;
  }

  const toPost: CodeGraphInsight[] = [];
  for (const insight of insights) {
    const prev = state.get(insight.deduplication_key);
    if (prev && prev.hash === insightHash(insight)) {
      result.skipped++;
      continue;
    }
    toPost.push(insight);
  }
  logEngram('sync.start', {
    project,
    insights: insights.length,
    toPost: toPost.length,
    skipped: result.skipped,
    stateEntries: state.size,
    stateMs: elapsedMs(startedAt),
  }, traceRoot);
  if (toPost.length === 0) {
    logEngram('sync.done', { project, ...result, ms: elapsedMs(startedAt) }, traceRoot);
    return result;
  }

  const sessionStartedAt = startTimer();
  const sessionId = await ensureSyncSession(engramUrl, project, traceRoot);
  const sessionMs = elapsedMs(sessionStartedAt);

  type Posted =
    | { ok: false }
    | { ok: true; id: number | string; key: string; retried: boolean };

  const postStartedAt = startTimer();
  const posted = await mapWithConcurrency(toPost, SYNC_CONCURRENCY, async (insight): Promise<Posted> => {
    const requestStartedAt = startTimer();
    try {
      let attempts = 0;
      const response = await fetchWithRetry(`${engramUrl}/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          title: insight.title,
          content: insight.content,
          type: insight.type,
          scope: 'project',
          project: insight.project,
          topic_key: insight.topic_key,
          deduplication_key: insight.deduplication_key,
          metadata: {
            qualified_name: insight.qualifiedName,
            file_path: insight.filePath,
            start_line: insight.startLine,
            caller_count: insight.callerCount,
            impact_count: insight.impactCount,
            confidence: insight.confidence,
            source: 'codegraph',
          },
        }),
      }, () => { attempts++; });

      const retried = attempts > 0;
      const ms = elapsedMs(requestStartedAt);
      if (!response.ok) {
        logEngram('sync.post', { key: insight.deduplication_key, ok: false, status: response.status, attempts, ms }, traceRoot);
        console.error(`[engram-sync] Failed to sync insight ${insight.deduplication_key}: ${response.status}`);
        return { ok: false };
      }
      const data = (await response.json()) as { id?: number | string };
      if (data.id === undefined) {
        logEngram('sync.post', { key: insight.deduplication_key, ok: false, reason: 'no-id', attempts, ms }, traceRoot);
        return { ok: false };
      }
      logEngram('sync.post', { key: insight.deduplication_key, ok: true, id: data.id, attempts, ms }, traceRoot);
      return { ok: true, id: data.id, key: insight.deduplication_key, retried };
    } catch (err) {
      logEngram('sync.post', {
        key: insight.deduplication_key, ok: false, error: describeError(err), ms: elapsedMs(requestStartedAt),
      }, traceRoot);
      console.error(`[engram-sync] Error syncing insight ${insight.deduplication_key}: ${err}`);
      return { ok: false };
    }
  });

  // Same deduplication key upserts the same id: a key the pre-sync local
  // state already knew counts as updated, a first-seen key as created. The
  // counts are observability only — server-side dedup by deduplication_key
  // stays correct regardless — so no revision GETs: trusting local state
  // drops N round-trips per sync (roughly half the requests on first syncs).
  const runtimeSeen = new Map(state);
  for (const p of posted) {
    if (!p.ok) continue;
    if (runtimeSeen.has(p.key)) result.updated++;
    else result.created++;
  }
  result.failed = posted.filter((p) => !p.ok).length;
  // Transparency, not a third outcome: how many POSTs needed more than one
  // attempt, so a reader of the counts knows a first-seen POST the server had
  // already processed before our attempt timed out reads back as `updated`.
  result.retried = posted.filter((p) => p.ok && p.retried).length;
  // Record hashes for everything posted OK (plus keep skipped entries)
  posted.forEach((p, idx) => {
    if (!p.ok) return;
    const ins = toPost[idx];
    if (ins) {
      runtimeSeen.set(p.key, {
        id: p.id,
        hash: insightHash(ins),
        filePath: ins.filePath,
        qualifiedName: ins.qualifiedName,
      });
    }
  });
  saveSyncState(options.rootDir, runtimeSeen);

  // One closing line per sync: the aggregate a reader wants first (how much
  // moved and how long it took), with each network phase timed separately so a
  // slow sync can be attributed without reading every per-request line.
  logEngram('sync.done', {
    project,
    ...result,
    posted: toPost.length,
    sessionMs,
    postMs: elapsedMs(postStartedAt),
    ms: elapsedMs(startedAt),
  }, traceRoot);

  return result;
}

/**
 * Content hash for change detection (FNV-1a 32-bit). Title + content cover
 * counts, callers, and flows — any material change re-syncs the insight.
 */
function insightHash(insight: CodeGraphInsight): string {
  const s = `${insight.title}\n${insight.content}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

type SyncStateEntry = {
  id: number | string;
  hash: string;
  /** Symbol identity for pruning (v3+). Absent on older entries. */
  filePath?: string;
  qualifiedName?: string;
};

/** Where a project's sync state lives. */
function syncStatePath(rootDir: string): string {
  return join(rootDir, '.codegraph', 'engram-sync-state.json');
}

/** A real state file is kilobytes; this bounds what one sync will parse. */
const SYNC_STATE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Why this state file must not be trusted, or null when it may be.
 *
 * Every accepted entry reaches the prune path as a delete, so the file has to
 * be the one this machine wrote into `.codegraph/`. A symlink breaks that: its
 * contents live outside the project and can be swapped for anyone else's file
 * without touching the project at all. The size bound is the cheap half — one
 * enormous file must not be parsed into memory on every sync.
 *
 * Absent is normal (first run) and returns null.
 */
function stateFileProblem(statePath: string): string | null {
  try {
    const stat = lstatSync(statePath);
    if (stat.isSymbolicLink()) return 'symlink';
    if (!stat.isFile()) return 'not-a-file';
    if (stat.size > SYNC_STATE_MAX_BYTES) return 'too-large';
    
  } catch {
    return null;
  }
  return null;
}

/**
 * Previously synced entries for a project root. Missing, corrupt, or older
 * state (v1 ids without hashes, or v2 without symbol identity) degrades
 * gracefully: unknown hashes sync once to record them, and entries with no
 * identity are never pruned. Never throws.
 *
 * A state file tracked by git is treated as absent — see
 * {@link stateFileIsTracked}: it is repository content, and pruning would obey
 * it. The cost is one re-sync that recreates the file locally; the copies in
 * Engram are left alone.
 */
function loadSyncState(rootDir?: string): Map<string, SyncStateEntry> {
  const out = new Map<string, SyncStateEntry>();
  if (!rootDir) return out;
  if (stateFileIsTracked(rootDir)) {
    logEngram('sync.state', { ignored: 'tracked-in-git' }, rootDir);
    return out;
  }
  const untrusted = stateFileProblem(syncStatePath(rootDir));
  if (untrusted) {
    logEngram('sync.state', { ignored: untrusted }, rootDir);
    return out;
  }
  try {
    const raw = JSON.parse(
      readFileSync(syncStatePath(rootDir), 'utf8')
    ) as {
      version?: number;
      idsByKey?: Record<string, number | string>;
      entries?: Record<string, { id?: number | string; hash?: string; filePath?: string; qualifiedName?: string }>;
    };
    if (raw && (raw.version === 2 || raw.version === 3) && raw.entries && typeof raw.entries === 'object') {
      for (const [k, v] of Object.entries(raw.entries)) {
        if (v && typeof v.hash === 'string' && (typeof v.id === 'number' || typeof v.id === 'string')) {
          out.set(k, {
            id: v.id,
            hash: v.hash,
            filePath: typeof v.filePath === 'string' ? v.filePath : undefined,
            qualifiedName: typeof v.qualifiedName === 'string' ? v.qualifiedName : undefined,
          });
        }
      }
    } else if (raw && raw.version === 1 && raw.idsByKey && typeof raw.idsByKey === 'object') {
      // v1 → current migration: ids kept, empty hash forces one re-sync to
      // record it (and, with it, the identity pruning needs).
      for (const [k, v] of Object.entries(raw.idsByKey)) {
        if (typeof v === 'number' || typeof v === 'string') out.set(k, { id: v, hash: '' });
      }
    }
  } catch { /* first run or unreadable — full sync */ }
  return out;
}

/**
 * Persist the sync state. `allowEmpty` exists for the prune: an empty map
 * there means "every synced insight is gone", which must be written — the
 * default guard would leave the deleted keys on disk to be retried forever.
 *
 * A symlinked path is never written through: writing would replace whatever it
 * points at, outside the project, on behalf of whoever planted the link.
 */
function saveSyncState(
  rootDir: string | undefined,
  entries: Map<string, SyncStateEntry>,
  allowEmpty = false,
): void {
  if (!rootDir) return;
  if (entries.size === 0 && !allowEmpty) return;
  const statePath = syncStatePath(rootDir);
  try {
    if (lstatSync(statePath).isSymbolicLink()) return;
  } catch { /* absent: the normal first write */ }
  try {
    mkdirSync(join(rootDir, '.codegraph'), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ version: 3, entries: Object.fromEntries(entries) })
    );
  } catch { /* best-effort; stateless fallback keeps working */ }
}

/**
 * Small English stopword set for memory queries. Engram search is
 * term-based (all terms must match), so natural-language queries
 * ("how does X work") return nothing unless filler words are stripped.
 */
const MEMORY_STOPWORDS = new Set([
  'how', 'what', 'when', 'where', 'why', 'which', 'who',
  'does', 'do', 'did', 'is', 'are', 'was', 'were', 'be',
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with',
  'and', 'or', 'it', 'this', 'that', 'by', 'from',
]);

function memoryQueryTerms(query: string): string {
  const terms = query
    .split(/[\s,().[\]]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !MEMORY_STOPWORDS.has(t.toLowerCase()));
  return terms.length > 0 ? terms.join(' ') : query;
}

export interface EngramMemoryHit {
  title: string;
  content: string;
  score: number;
  type: string;
}

async function fetchMemoryHits(
  terms: string,
  limit: number,
  project: string | undefined,
  engramUrl: string,
  rootDir?: string,
): Promise<EngramMemoryHit[]> {
  const params = new URLSearchParams({ q: terms, limit: String(limit) });
  if (project) params.set('project', project);

  const startedAt = startTimer();
  const response = await fetchWithRetry(`${engramUrl}/search?${params}`);
  if (!response.ok) {
    // A non-2xx here looks identical to "no matching memory" in the tool
    // output, which is why it gets its own trace line and status.
    logEngram('memory.fetch', {
      project, terms, limit, ok: false, status: response.status, ms: elapsedMs(startedAt),
    }, rootDir);
    return [];
  }

  // Real API returns a bare array of observations (rank doubles as score).
  // Rows may carry nulls (session markers, imports) — coerce, never throw.
  const data = (await response.json()) as Array<{ title: string; content: string; rank?: number; type: string }>;
  return (Array.isArray(data) ? data : []).map((r) => ({
    title: String(r.title ?? 'Untitled'),
    content: String(r.content ?? ''),
    score: r.rank ?? 0,
    type: r.type || 'unknown',
  }));
}

/**
 * Search Engram memory for context relevant to a query.
 *
 * Returns matching observations that can enrich explore results.
 *
 * Engram search is term-AND: every term must occur in the same row. Code
 * queries (`authentication login`) use code vocabulary that often matches
 * nothing in prose memory (`auth`, `test_auth_login`), so a strict miss
 * falls back to per-term (OR) retrieval merged by score — bounded to `limit`
 * and cached like the strict path. Extra fetches happen only on a miss.
 */
export async function searchEngramMemory(
  query: string,
  options: { limit?: number; project?: string; engramUrl?: string; rootDir?: string } = {}
): Promise<EngramMemoryHit[]> {
  const { limit = 3, project, engramUrl = process.env.ENGRAM_URL || 'http://127.0.0.1:7437', rootDir } = options;
  const startedAt = startTimer();

  // Check cache first (keyed by backend + project + query + limit)
  const cacheKey = getCacheKey(project, query, engramUrl, limit);
  const cached = getCachedResults(cacheKey);
  if (cached) {
    logEngram('memory.search', {
      project, query, limit, count: cached.length, cache: 'strict', ms: elapsedMs(startedAt),
    }, rootDir);
    return cached;
  }

  try {
    const terms = memoryQueryTerms(query);
    const results = await fetchMemoryHits(terms, limit, project, engramUrl, rootDir);
    if (results.length > 0) {
      // Cache results
      setCachedResults(cacheKey, results);
      logEngram('memory.search', {
        project, query, terms, limit, count: results.length, fallback: false, ms: elapsedMs(startedAt),
      }, rootDir);
      return results;
    }

    // Fallback results live under their own key: caching them under the
    // strict key would keep serving OR-merged rows for 60s even after new
    // data arrives that matches the strict AND query. Strict empties stay
    // uncached so a later strict hit is always discovered fresh.
    const orCacheKey = `${cacheKey}${'\u0000'}or`;
    const orCached = getCachedResults(orCacheKey);
    if (orCached) {
      logEngram('memory.search', {
        project, query, limit, count: orCached.length, cache: 'or', fallback: true, ms: elapsedMs(startedAt),
      }, rootDir);
      return orCached;
    }

    const { hits: orResults, asked } = await fetchMemoryHitsOr(terms, limit, project, engramUrl, rootDir);
    setCachedResults(orCacheKey, orResults);
    logEngram('memory.search', {
      project, query, terms, variants: asked, limit, count: orResults.length, fallback: true, ms: elapsedMs(startedAt),
    }, rootDir);
    return orResults;
  } catch (err) {
    logEngram('memory.search', {
      project, query, limit, ok: false, error: describeError(err), count: 0, ms: elapsedMs(startedAt),
    }, rootDir);
    return [];
  }
}

/**
 * Diacritic-folded spelling of a search term: `decisión` → `decision`.
 *
 * Engram's index keeps accented and unaccented spellings as separate tokens —
 * measured against the live server, `integración` answers 5 rows while
 * `integracion` answers 0, and `sesión` 4 while `sesion` 2, over different row
 * sets. A query written with the accent therefore misses every note written
 * without it. Folding cannot invent an accent, so this covers accented query →
 * unaccented memory only; the reverse needs the server to fold at index time.
 */
function foldDiacritics(term: string): string {
  return term.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** One query term plus the folded spelling worth asking for, when it differs. */
function termVariants(term: string): string[] {
  const folded = foldDiacritics(term);
  return folded !== term && folded.length >= 3 ? [term, folded] : [term];
}

/**
 * Per-term spellings an OR fallback asks Engram for: each term as written,
 * plus its folded form when that differs. One derivation feeds both the
 * fetches and the trace line, so the record cannot claim a spelling the
 * search never sent.
 */
function memoryQueryVariants(terms: string): string[][] {
  return terms
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(termVariants);
}

/**
 * Per-term (OR) retrieval, used only on a strict-AND miss. All single-term
 * fetches run in parallel (independent HTTP round trips — serially they
 * cost N× one trip), each fetching deeper than `limit` so the merge below —
 * not the per-term cutoff — decides what survives. Rows are ranked by
 * number of matched terms first (a row matching 2 of 3 terms outranks one
 * matching 1), then by score; without this, the first term fills every slot
 * and a row only the second term matches is never even fetched (starvation).
 * Score polarity follows the server (FTS5 bm25: more negative = stronger
 * match, best-first — verified live: multi-term strict hits rank more
 * negative than any single-term hit): sort ascending. Bounded to `limit`.
 *
 * An accented term is asked for twice, as written and folded: the strict query
 * could not have matched a note spelled the other way, and neither could this
 * fallback before, so `decisión` answered nothing while `decision` answered
 * five rows. `asked` reports every spelling actually sent, so the trace shows
 * the fold instead of leaving it implied.
 */
async function fetchMemoryHitsOr(
  terms: string,
  limit: number,
  project: string | undefined,
  engramUrl: string,
  rootDir?: string,
): Promise<{ hits: EngramMemoryHit[]; asked: string[] }> {
  const groups = memoryQueryVariants(terms);
  if (groups.length === 0) return { hits: [], asked: [] };
  // A lone plain term was already asked for verbatim by the strict query;
  // repeating it by itself buys nothing.
  if (groups.length === 1 && groups[0]!.length === 1) return { hits: [], asked: [] };
  // Every spelling sent, in query order, deduped: a repeated word must not
  // read as a second request in the trace.
  const asked = [...new Set(groups.flat())];
  // Depth per term comfortably above `limit` (never below 5): multi-match
  // rows ranked low in one term's list still reach the merge.
  const depth = Math.max(limit, 5);
  const settled = await Promise.all(
    groups.map((variants, groupIndex) =>
      Promise.all(
        variants.map((variant) =>
          fetchMemoryHits(variant, depth, project, engramUrl, rootDir).catch((): EngramMemoryHit[] => [])
        )
      ).then((lists) => ({ groupIndex, lists }))
    )
  );

  // Track which query TERMS matched, as the set of group indices: two
  // spellings of one word are one term, so a row found by both must not count
  // twice and leapfrog a row that really matched two different words.
  const byKey = new Map<string, { hit: EngramMemoryHit; terms: Set<number> }>();
  for (const { groupIndex, lists } of settled) {
    for (const hits of lists) {
      for (const h of hits) {
        const key = `${h.title}\n${h.content.slice(0, 160)}`;
        const entry = byKey.get(key);
        if (entry) {
          entry.terms.add(groupIndex);
          // Rank polarity follows the server (FTS5 bm25: more negative =
          // stronger match): keep the row's strongest leg.
          if (h.score < entry.hit.score) entry.hit = h;
        } else {
          byKey.set(key, { hit: h, terms: new Set([groupIndex]) });
        }
      }
    }
  }
  // Term count first (polarity-independent), then strongest-match-first.
  return {
    hits: [...byKey.values()]
      .sort((a, b) => b.terms.size - a.terms.size || a.hit.score - b.hit.score)
      .slice(0, limit)
      .map((e) => e.hit),
    asked,
  };
}
