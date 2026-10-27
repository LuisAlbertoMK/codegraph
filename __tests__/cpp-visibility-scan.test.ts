/**
 * A C++ member's visibility comes from the access specifier in its class body,
 * and the extractor asks for it once per member — for a class body that means
 * every inline method. The scan was done per member, so a body with many
 * members was quadratic. Measured on a single `struct` of inline methods:
 * 500 members 3.5 s, 1500 members 10.1 s, 3000 members 31.6 s to index; the
 * scan only ends early when it finds a specifier, so a body with none (a
 * struct's members are public by default) paid the full body scan per member.
 *
 * The answer is a property of the BODY, not of the member, so it is now read
 * once per body and remembered for the rest of that parse tree. The rule itself
 * is untouched: the first `access_specifier` among the body's children is the
 * answer for every member of that body.
 *
 * The first test is the semantic guard, the second is the cost guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

/** 4000 members: about a minute before, a few seconds after. */
const MEMBERS = 4000;
/** Wide margin over the fixed scan; the defect took far longer at this size. */
const BUDGET_MS = 15_000;

let root = '';
let cg: CodeGraph | undefined;
let kernel: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-visibility-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // The cost guard measures the JavaScript extractor, where the scan lives.
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

describe('C++ member visibility', () => {
  it('reads the specifier from the class body', async () => {
    fs.writeFileSync(
      path.join(root, 'src', 'widget.cpp'),
      'class Widget {\npublic:\n  int area() { return 1; }\n};\n\n' +
      'class Hidden {\nprivate:\n  int secret() { return 2; }\n};\n\n' +
      'struct Plain {\n  int size() { return 3; }\n};\n',
    );

    cg = await CodeGraph.init(root, { index: true });
    const visibility = (name: string): string | null | undefined => {
      const node = cg!.getNodesInFile('src/widget.cpp').find((n) => n.name === name);
      expect(node, `no node for ${name}`).toBeTruthy();
      return node!.visibility;
    };

    expect(visibility('area')).toBe('public');
    expect(visibility('secret')).toBe('private');
    // No specifier in the body: the same absent answer as before, now without
    // scanning the whole body for every member. (The database stores "no
    // visibility" as NULL.)
    expect(visibility('size') ?? null).toBeNull();
  }, 120_000);

  it('follows each section of a body, not the first one it finds', async () => {
    // The nearest PRECEDING specifier answers for a member — what C++ means and
    // what the native kernel does. Answering with the body's FIRST specifier
    // labelled `hidden` public, and `early` — written before any specifier —
    // took `public` from the section below it.
    fs.writeFileSync(
      path.join(root, 'src', 'sections.cpp'),
      'class Sections {\n' +
      '  int early() { return 0; }\n' +
      '\npublic:\n' +
      '  int openMethod() { return 1; }\n' +
      '\nprivate:\n' +
      '  int hidden() { return 2; }\n' +
      '\nprotected:\n' +
      '  int derivedOnly() { return 3; }\n' +
      '};\n\n' +
      'struct Defaults {\n' +
      '  int plain() { return 4; }\n' +
      'private:\n' +
      '  int restricted() { return 5; }\n' +
      '};\n',
    );

    cg = await CodeGraph.init(root, { index: true });
    const visibility = (name: string): string | null | undefined => {
      const node = cg!.getNodesInFile('src/sections.cpp').find((n) => n.name === name);
      expect(node, `no node for ${name}`).toBeTruthy();
      return node!.visibility ?? null;
    };

    expect(visibility('early')).toBeNull();
    expect(visibility('openMethod')).toBe('public');
    expect(visibility('hidden')).toBe('private');
    expect(visibility('derivedOnly')).toBe('protected');
    expect(visibility('plain')).toBeNull();
    expect(visibility('restricted')).toBe('private');
  }, 120_000);

  it('indexes a large specifier-less body in time linear in its members', async () => {
    const methods = Array.from({ length: MEMBERS }, (_, i) => `  int m${i}() { return ${i}; }\n`).join('');
    fs.writeFileSync(path.join(root, 'src', 'big.cpp'), `struct Big {\n${methods}};\n`);

    const started = Date.now();
    cg = await CodeGraph.init(root, { index: true });
    const elapsed = Date.now() - started;

    const methodsIndexed = cg.getNodesInFile('src/big.cpp').filter((n) => n.kind === 'method');
    expect(methodsIndexed.length).toBe(MEMBERS);
    expect(elapsed, `${MEMBERS} members took ${elapsed}ms`).toBeLessThan(BUDGET_MS);
  }, 180_000);
});
