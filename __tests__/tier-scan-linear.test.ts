/**
 * Tier-synthesis scans must stay linear on a file that is one long dotted chain.
 *
 * `crossTierEdges` runs its client-call / queue / event scanners over the
 * content of every JS-family file. Those patterns described a receiver as an
 * UNBOUNDED dotted chain:
 *
 *   ((?:this\s*\.\s*)?W(?:\s*\.\s*W)*)\s*\.\s*(add|process|get|post|...)
 *   ((?:[\w$]+(?:\([^()]*\))?\s*\.\s*)*[\w$]+)\s*\.\s*(emit|on|once)
 *
 * A minified bundle - one line, `a.b.c...`, no whitespace - is exactly the
 * input where the engine retries the whole remaining chain from every start
 * position: O(n2). Measured at 100 KB of `a.` repeated: 49 s (`queue.add`),
 * 51 s (`queue.process`), 52 s (the HTTP verb), 60 s (`emit`), 59 s
 * (`socket.on`) - five passes over one vendored bundle.
 *
 * Capping the chain at 32 segments makes each attempt constant time and
 * changes no real receiver: nothing hand-written has 32 dotted segments.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/** `a.` x this many = a 60 KB single line: a small, representative minified shape. */
const SEGMENTS = 30_000;
/** Wide margin: the fix takes a few seconds with fixture setup; the defect took minutes. */
const BUDGET_MS = 15_000;

describe('tier synthesis - one long dotted chain', () => {
  it('indexes a minified-shaped bundle without a quadratic scan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-linear-'));
    let cg: CodeGraph | null = null;
    let elapsed = 0;
    let chainLength = 0;
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // One line, no whitespace, ending in a real event subscription so the
      // scanners cannot bail out before reaching the dangerous part.
      const chain = 'a.'.repeat(SEGMENTS);
      chainLength = chain.length;
      fs.writeFileSync(path.join(dir, 'src', 'bundle.js'), `var x=${chain}on('e',f);\n`);
      fs.writeFileSync(path.join(dir, 'src', 'plain.js'), 'export function plain() { return 1; }\n');

      const started = Date.now();
      cg = await CodeGraph.init(dir, { silent: true });
      await cg.indexAll();
      elapsed = Date.now() - started;
      expect(cg.getStats().fileCount).toBe(2);
    } finally {
      // Close before asserting/removing: an open SQLite handle makes rmSync fail
      // with EPERM on Windows and would mask the timing failure.
      try { cg?.destroy(); } catch { /* best effort */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(elapsed, `${chainLength} chars on one line took ${elapsed}ms`).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it('indexes an Express route whose handler body is one long dotted chain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-express-'));
    let cg: CodeGraph | null = null;
    let elapsed = 0;
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      const chain = 'a.'.repeat(SEGMENTS);
      fs.writeFileSync(
        path.join(dir, 'src', 'server.js'),
        `const express = require('express');\nconst app = express();\n` +
        `app.get('/x', (req, res) => { const v = ${chain}call(); res.json(v); });\n`,
      );
      const started = Date.now();
      cg = await CodeGraph.init(dir, { silent: true });
      await cg.indexAll();
      elapsed = Date.now() - started;
      expect(cg.getStats().fileCount).toBe(1);
    } finally {
      try { cg?.destroy(); } catch { /* best effort */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(elapsed, `express handler body took ${elapsed}ms`).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
