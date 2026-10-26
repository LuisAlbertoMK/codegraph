/**
 * `extractDecoratorsFor` runs once per function, method, class and property, and
 * its second half looks for decorators written as PRECEDING SIBLINGS of the
 * declaration (the TypeScript `@Foo class Bar {}` shape).
 *
 * It used to locate the declaration by scanning the parent's children from 0
 * until `startIndex` matched, then walk back from there. Locating it that way
 * costs one `namedChild(i)` call — a WASM marshal/unmarshal round-trip — per
 * sibling of the PARENT, so a parent holding many declarations went O(n^2). A
 * minified bundle is exactly that: one `program` node with thousands of
 * top-level statements on a single line. Measured on a 1 MB one-line file
 * before the fix: 158 s of a 183 s index spent here, against a fraction of a
 * second after it. On the fixture below (8000 top-level declarations):
 * 32.2 s before, 2.6 s after.
 *
 * The walk now starts from `anchor.previousNamedSibling` — one C-side call per
 * step, and it stops at the first non-decorator, so it is O(1) in the common
 * case. The first test here is the semantic guard (a class decorator still
 * links), the second is the cost guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

/** Enough declarations that the quadratic term dominates: 32 s before, 2.6 s after. */
const DECLARATIONS = 8000;
/** Wide margin over the 2.6 s the fixed walk needs; the defect took 32 s. */
const BUDGET_MS = 12_000;

let root = '';
let cg: CodeGraph | undefined;
let kernel: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-decorator-scan-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // The cost guard measures the JavaScript extractor, which is the one the
  // defect was in; a native kernel would bypass it.
  kernel = process.env.CODEGRAPH_KERNEL;
  process.env.CODEGRAPH_KERNEL = '0';
});

afterEach(() => {
  cg?.close();
  cg = undefined;
  fs.rmSync(root, { recursive: true, force: true });
  if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = kernel;
});

describe('decorator sibling scan', () => {
  it('still links a decorator written above the declaration', async () => {
    fs.writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      'export function Component(opts: unknown): ClassDecorator { return () => {}; }\n' +
      'export function Input(): PropertyDecorator { return () => {}; }\n',
    );
    fs.writeFileSync(
      path.join(root, 'src', 'app.ts'),
      "import { Component, Input } from './lib';\n" +
      "\n" +
      "@Component({ selector: 'app' })\n" +
      'export class Widget {\n' +
      "  @Input() name = '';\n" +
      '}\n',
    );

    cg = await CodeGraph.init(root, { index: true });
    const ids = cg.getNodesInFile('src/app.ts').map((n) => n.id);
    const links = cg.getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'decorates')
      .map((e) => {
        const from = cg!.getNode(e.source)!;
        const to = cg!.getNode(e.target)!;
        return `${from.qualifiedName} @${String(e.metadata?.refName ?? '')} -> ${to.kind} ${to.filePath}:${to.qualifiedName}`;
      })
      .sort();

    expect(links).toEqual([
      'Widget @Component -> function src/lib.ts:Component',
      'Widget::name @Input -> function src/lib.ts:Input',
    ]);
  });

  it('scans a file of many declarations in time linear in its length', async () => {
    // One line, no whitespace between declarations — a minified bundle. Every
    // declaration is a sibling of every other, which is what made the old
    // index-based lookup quadratic.
    const body = Array.from({ length: DECLARATIONS }, (_, i) => `function f${i}(a){return a+${i}}`).join('');
    fs.writeFileSync(path.join(root, 'src', 'bundle.js'), `${body}\n`);

    const started = Date.now();
    cg = await CodeGraph.init(root, { index: true });
    const elapsed = Date.now() - started;

    const functions = cg.getNodesInFile('src/bundle.js').filter((n) => n.kind === 'function');
    expect(functions.length).toBe(DECLARATIONS);
    expect(elapsed, `${DECLARATIONS} declarations took ${elapsed}ms`).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
