/**
 * Cross-machine benchmark: OLD vs NEW CodeGraph engine on any project.
 *
 * Measures cold-index wall time + insight-extraction wall time using a given
 * dist build, always on a TEMP COPY of the project (never touches the source).
 * No Engram writes. Memory search is measured read-only and only with --engram-url.
 *
 * Usage:
 *   node scripts/benchmark-cross-machine.mjs --dist <path-to-dist> --project <path> [--label <name>]
 *     [--index-runs 2] [--extract-runs 10] [--mem-runs 0] [--engram-url http://127.0.0.1:7437]
 *     [--workdir <temp-parent>]
 *
 * Example (compare two builds on the same project):
 *   node scripts/benchmark-cross-machine.mjs --dist ./dist --project D:/myapp --label myapp-new
 *   node scripts/benchmark-cross-machine.mjs --dist ../codegraph-baseline/dist --project D:/myapp --label myapp-old
 *
 * Report MEDIANS (+p95), never means alone — box variance is ±25-40%.
 * Run both arms back-to-back on an otherwise idle box and state the conditions.
 */

import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

import { spawn } from 'node:child_process';
function runCode(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', () => resolve(-1));
    p.on('close', (code) => resolve(code ?? -1));
  });
}

function arg(name, def = undefined) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? def : v;
}

const DIST = resolve(arg('dist', './dist'));
const PROJECT = resolve(arg('project', ''));
const LABEL = arg('label', 'bench');
const INDEX_RUNS = Math.max(1, parseInt(arg('index-runs', '2'), 10));
const EXTRACT_RUNS = Math.max(1, parseInt(arg('extract-runs', '10'), 10));
const MEM_RUNS = Math.max(0, parseInt(arg('mem-runs', '0'), 10));
const ENGRAM_URL = arg('engram-url', process.env.ENGRAM_URL || '');
const WORKPARENT = resolve(arg('workdir', join(tmpdir(), 'cg-bench')));

if (!PROJECT || !existsSync(PROJECT)) {
  console.error('missing/unknown --project <path>');
  process.exit(2);
}
if (!existsSync(join(DIST, 'bin', 'codegraph.js'))) {
  console.error('no build at --dist ' + DIST + ' (expected dist/bin/codegraph.js — run npm run build first)');
  process.exit(2);
}

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
};

const idx = await import(pathToFileURL(join(DIST, 'index.js')).href);
const engramSync = await import(pathToFileURL(join(DIST, 'integrations', 'engram-sync.js')).href);
const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;
if (typeof CodeGraph?.open !== 'function' || typeof engramSync?.extractInsights !== 'function') {
  console.error('dist API mismatch: need CodeGraph.open + extractInsights in ' + DIST);
  process.exit(2);
}

// Work on a temp copy — the source project is never indexed or modified.
// Tolerant copy: skips scan-ignored dirs and survives denied entries
// (Node's cpSync fast-fails on things like locked .pytest_cache on Windows).
mkdirSync(WORKPARENT, { recursive: true });
const work = mkdtempSync(join(WORKPARENT, LABEL + '-'));
const copy = join(work, 'proj');
mkdirSync(copy, { recursive: true });
if (process.platform === 'win32') {
  const rc = await runCode('robocopy', [PROJECT, copy, '/E', '/XD', '.git', '.codegraph', 'node_modules', '.venv', '.pytest_cache', '/R:1', '/W:1', '/NJH', '/NJS']);
  if (rc >= 8 || rc === -1) throw new Error('robocopy failed with code ' + rc);
} else {
  await execFileAsync('cp', ['-a', PROJECT + '/.', copy + '/']);
  for (const d of ['.git', '.codegraph', 'node_modules', '.venv', '.pytest_cache']) {
    rmSync(join(copy, d), { recursive: true, force: true });
  }
}
rmSync(join(copy, '.codegraph'), { recursive: true, force: true });

const BIN = join(DIST, 'bin', 'codegraph.js');

// Cold index: fresh init per run (init builds the initial index — same work as index from scratch).
const indexWalls = [];
for (let i = 0; i < INDEX_RUNS; i++) {
  rmSync(join(copy, '.codegraph'), { recursive: true, force: true });
  const t0 = Date.now();
  await execFileAsync(process.execPath, [BIN, 'init', '-y', copy], { timeout: 20 * 60 * 1000 });
  indexWalls.push(Date.now() - t0);
}

// Extraction end-to-end (defaults, 50 insights + flows).
const cg = await CodeGraph.open(copy);
const extractWalls = [];
let insights = 0;
for (let i = 0; i < EXTRACT_RUNS; i++) {
  const t0 = Date.now();
  const ins = await engramSync.extractInsights(cg, { project: LABEL });
  extractWalls.push(Date.now() - t0);
  insights = ins.length;
}

// Node/edge census for normalization.
let census = {};
try {
  const st = await execFileAsync(process.execPath, [BIN, 'status', copy]);
  const m = (re) => { const m2 = st.stdout.match(re); return m2 ? parseInt(m2[1].replace(/,/g, ''), 10) : null; };
  census = { files: m(/Files:\s+([\d,]+)/), nodes: m(/Nodes:\s+([\d,]+)/), edges: m(/Edges:\s+([\d,]+)/) };
} catch { /* status is best-effort */ }
try { await cg.close?.(); } catch { /* ignore */ }

// Read-only memory search (no writes), only when asked.
let mem = null;
if (MEM_RUNS > 0 && ENGRAM_URL) {
  const walls = [];
  let hits = 0;
  for (let i = 0; i < MEM_RUNS; i++) {
    const t0 = Date.now();
    const res = await engramSync.searchEngramMemory('index sync extraction', { limit: 3, engramUrl: ENGRAM_URL });
    walls.push(Date.now() - t0);
    hits = res.length;
  }
  mem = { ...stats(walls), hits };
}

console.log(JSON.stringify({
  label: LABEL,
  dist: DIST,
  source: PROJECT,
  workdir: work,
  node: process.version,
  census: { ...census, insights },
  index_ms: stats(indexWalls),
  extract_ms: stats(extractWalls),
  memsearch_ms: mem,
}, null, 2));
console.error(`[bench] work copy kept at ${work} (delete when done)`);
