/**
 * Engram integration diagnostics — a bounded JSONL trace of every memory
 * search, insight extraction, sync attempt and tool call that touches Engram.
 *
 * Why a file: the integration is deliberately fire-and-forget and degrades to
 * "no results" when Engram is slow, down, or answers nothing. Without a trace
 * the only visible outcome is an empty list, which cannot be told apart from
 * "no project memory exists yet". One line per event, with a duration, makes
 * that distinguishable after the fact — offline, with no server to query.
 *
 * Defaults: ON, one file per project at `<root>/.codegraph/engram-debug.jsonl`
 * (inside the gitignored index directory), rotated at 1 MB with one previous
 * generation kept.
 *
 *   CODEGRAPH_ENGRAM_DEBUG=0|false|off   turn the trace off
 *   CODEGRAPH_ENGRAM_DEBUG_FILE=<path>   write somewhere else
 *   CODEGRAPH_ENGRAM_DEBUG_MAX_BYTES=<n> rotation threshold (default 1 MiB)
 *
 * Every function here is best-effort: a trace must never throw into indexing
 * or into a tool call.
 */

import { appendFileSync, lstatSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const FILE_NAME = 'engram-debug.jsonl';

/** Trace switch. ON unless explicitly disabled — the trace is the only record. */
export function engramDebugEnabled(): boolean {
  const raw = (process.env.CODEGRAPH_ENGRAM_DEBUG ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function maxBytes(): number {
  const raw = parseInt(process.env.CODEGRAPH_ENGRAM_DEBUG_MAX_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

/**
 * Where this project's trace lives, or null when there is nowhere to put it.
 * An explicit CODEGRAPH_ENGRAM_DEBUG_FILE always wins; otherwise the trace
 * belongs to the project's own `.codegraph/` directory, which is already
 * gitignored and travels with the index it describes.
 */
export function engramLogPath(rootDir?: string): string | null {
  const override = process.env.CODEGRAPH_ENGRAM_DEBUG_FILE?.trim();
  if (override) return override;
  if (!rootDir) return null;
  return join(rootDir, '.codegraph', FILE_NAME);
}

export type EngramLogFields = Record<string, unknown>;

/**
 * Announce the resolved trace path once per process, on stderr. Without this a
 * reader who expects the trace in one place and finds it in another has no way
 * to tell which process wrote where — the file is per project by default, but
 * CODEGRAPH_ENGRAM_DEBUG_FILE (or the server's cwd) can move it.
 */
let announcedPath: string | null = null;

/**
 * Append one event. `ms` is the field to reach for when reading the trace:
 * every caller that can time something should pass it.
 */
export function logEngram(event: string, fields: EngramLogFields = {}, rootDir?: string): void {
  if (!engramDebugEnabled()) return;
  const file = engramLogPath(rootDir);
  if (!file) return;
  if (announcedPath !== file) {
    announcedPath = file;
    try { console.error(`[engram-log] trace: ${file} (pid ${process.pid})`); } catch { /* stderr closed */ }
  }
  try {
    // Never append through a symlink. The trace path is predictable, so a
    // linked one lets anything that can write `.codegraph/` append
    // attacker-chosen text to a file of its choosing, one line at a time.
    if (lstatSync(file).isSymbolicLink()) return;
  } catch { /* absent: the normal first write */ }
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file);
    // `pid` distinguishes the process that answered: a tool call can be served
    // by the session's own launcher or by the shared daemon, and which one it
    // was decides which build (and which env) the numbers came from.
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...fields }) + '\n');
  } catch { /* diagnostics must never break the caller */ }
}

/** Keep the trace bounded: one previous generation, then start over. */
function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size < maxBytes()) return;
  } catch {
    return; // missing file: nothing to rotate
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // A rename that fails (locked file on Windows, permissions) must not stop
    // the write — the size cap is a courtesy, not a correctness requirement.
  }
}

/** Milliseconds elapsed since `startedAt`, rounded — every event carries one. */
export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** Start a timer. `elapsedMs(t)` when the work is done. */
export function startTimer(): number {
  return performance.now();
}

/** One-line, human-readable description of a failure for the trace. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
