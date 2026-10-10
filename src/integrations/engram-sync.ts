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
  /** Insight type for Engram categorization */
  type: 'symbol' | 'flow' | 'pattern' | 'architecture';
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
  /** Maximum number of insights to extract (default: 50) */
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
    maxInsights = 50,
    minCallers = 3,
    minImpact = 5,
    project = process.cwd().split(/[\\/]/).pop() || 'unknown',
    includeFlows = true,
  } = options;

  // Get all code-bearing nodes
  const allNodes = graph.getNodesByKind('function')
    .concat(graph.getNodesByKind('method'))
    .concat(graph.getNodesByKind('class'))
    .concat(graph.getNodesByKind('interface'));

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
  byCallers.sort((a, b) => b.callerCount - a.callerCount);

  // Score centrality for the pool only. Batched membership: one handful of
  // round trips per node instead of one per walk step (~3.2x measured).
  const scored: Array<{ node: Node; callerCount: number; impactCount: number; score: number }> = [];
  for (const { node, callerCount } of byCallers.slice(0, poolSize)) {
    const impactCount = graph.getImpactIdsBatched(node.id, 2).size;
    if (impactCount < minImpact) continue;
    const score = callerCount * Math.log(impactCount + 1);
    scored.push({ node, callerCount, impactCount, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top N
  const top = scored.slice(0, maxInsights);

  // Build insights
  const insights: CodeGraphInsight[] = [];
  for (const { node, callerCount, impactCount } of top) {
    // Caller names only for the final top-N — one cheap lookup each.
    // Impacted names via batched membership + a 5-row fetch (focal first, as
    // before). Sample order follows BFS discovery (was DFS) — names only.
    const callers = graph.getCallers(node.id, 1);
    const impactSample = [...graph.getImpactIdsBatched(node.id, 2)].slice(0, 5);
    const impactNodes = impactSample.length > 1 ? graph.getNodesByIds(impactSample.slice(1)) : new Map<string, Node>();
    const topCallers = callers
      .slice(0, 5)
      .map(c => c.node.name);

    const topImpacted = impactSample.map((id, i) => i === 0 ? node.name : impactNodes.get(id)?.name ?? id);

    const confidence = Math.min(1, (callerCount / 20) + (impactCount / 50));

    const insight: CodeGraphInsight = {
      deduplication_key: `codegraph:${project}:${node.qualifiedName}`,
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
    insights.push(...flowInsights);
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
      deduplication_key: `codegraph:${project}:flow:${insight.qualifiedName}`,
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

async function ensureSyncSession(engramUrl: string, project: string): Promise<string> {
  const sessionId = syncSessionIdFor(project);
  try {
    await fetchWithTimeout(`${engramUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, project }),
    });
  } catch { /* best-effort; saves surface failures with counts */ }
  return sessionId;
}

/**
 * Engram HTTP timeout (ms). A hung Engram (socket accepted, never responds)
 * must never stall the fire-and-forget post-index chain — it only delays
 * background memory, never indexing. Override with ENGRAM_TIMEOUT_MS.
 */
function getEngramTimeoutMs(): number {
  const raw = parseInt(process.env.ENGRAM_TIMEOUT_MS || '10000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
  const ms = timeoutMs ?? getEngramTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sync insights to Engram via HTTP.
 *
 * Uses the Engram HTTP API (POST /observations) with deduplication.
 * Failures are logged but never throw — insight sync must not break indexing.
 */
export async function syncInsightsToEngram(
  insights: CodeGraphInsight[],
  engramUrl: string = process.env.ENGRAM_URL || 'http://127.0.0.1:7437'
): Promise<{ created: number; updated: number; failed: number }> {
  const result = { created: 0, updated: 0, failed: 0 };
  if (insights.length === 0) return result;

  const project = insights[0]?.project || 'codegraph';
  const sessionId = await ensureSyncSession(engramUrl, project);

  for (const insight of insights) {
    try {
      const response = await fetchWithTimeout(`${engramUrl}/observations`, {
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
      });

      if (!response.ok) {
        result.failed++;
        console.error(`[engram-sync] Failed to sync insight ${insight.deduplication_key}: ${response.status}`);
        continue;
      }
      const data = (await response.json()) as { id?: number | string };
      if (data.id === undefined) {
        result.failed++;
        continue;
      }
      // Same deduplication key upserts the same id: first revision counts as
      // created, later ones as updated.
      try {
        const current = (await (await fetchWithTimeout(`${engramUrl}/observations/${data.id}`)).json()) as { revision_count?: number; duplicate_count?: number };
        if ((current.revision_count ?? 1) <= 1 && (current.duplicate_count ?? 0) === 0) result.created++;
        else result.updated++;
      } catch {
        result.updated++;
      }
    } catch (err) {
      result.failed++;
      console.error(`[engram-sync] Error syncing insight ${insight.deduplication_key}: ${err}`);
    }
  }

  return result;
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

/**
 * Search Engram memory for context relevant to a query.
 *
 * Returns matching observations that can enrich explore results.
 */
export async function searchEngramMemory(
  query: string,
  options: { limit?: number; project?: string; engramUrl?: string } = {}
): Promise<Array<{ title: string; content: string; score: number; type: string }>> {
  const { limit = 3, project, engramUrl = process.env.ENGRAM_URL || 'http://127.0.0.1:7437' } = options;

  try {
    const params = new URLSearchParams({ q: memoryQueryTerms(query), limit: String(limit) });
    if (project) params.set('project', project);

    const response = await fetchWithTimeout(`${engramUrl}/search?${params}`);
    if (!response.ok) return [];

    // Real API returns a bare array of observations (rank doubles as score).
    // Rows may carry nulls (session markers, imports) — coerce, never throw.
    const data = (await response.json()) as Array<{ title: string; content: string; rank?: number; type: string }>;
    return (Array.isArray(data) ? data : []).map((r) => ({
      title: String(r.title ?? 'Untitled'),
      content: String(r.content ?? ''),
      score: r.rank ?? 0,
      type: r.type || 'unknown',
    }));
  } catch {
    return [];
  }
}
