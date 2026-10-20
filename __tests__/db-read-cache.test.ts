/**
 * Read-side memoization in QueryBuilder.
 *
 * `getTopDependedOn` is a GROUP BY over the whole edge table (~175 ms on a
 * 95k-edge index) and `getStats` runs five full-table aggregates; both are
 * asked for at the top of most viewer API handlers. They are cached against
 * the connection's change stamp, so the contract that matters is:
 *
 *   1. a repeated read is the same answer,
 *   2. a write invalidates it (no stale counts after a sync), and
 *   3. a caller mutating what it received cannot poison the next caller.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Edge, Node } from '../src/types';

function makeNode(id: string): Node {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

function makeEdge(source: string, target: string): Edge {
  return { source, target, kind: 'calls', provenance: 'tree-sitter' };
}

describe('QueryBuilder read memoization', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-read-cache-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caches getTopDependedOn until the edge table changes', () => {
    q.insertNodes([makeNode('a'), makeNode('b'), makeNode('c'), makeNode('t')]);
    q.insertEdges([makeEdge('a', 't'), makeEdge('b', 't')]);

    expect(q.getTopDependedOn(10)).toEqual([{ nodeId: 't', dependents: 2 }]);

    // A third dependent is a write; the change stamp must drop the memo.
    q.insertEdges([makeEdge('c', 't')]);
    expect(q.getTopDependedOn(10)).toEqual([{ nodeId: 't', dependents: 3 }]);
  });

  it('keys getTopDependedOn by limit', () => {
    q.insertNodes([makeNode('a'), makeNode('b'), makeNode('x'), makeNode('y')]);
    q.insertEdges([makeEdge('a', 'x'), makeEdge('a', 'y'), makeEdge('b', 'x')]);

    expect(q.getTopDependedOn(1)).toEqual([{ nodeId: 'x', dependents: 2 }]);
    expect(q.getTopDependedOn(2)).toEqual([
      { nodeId: 'x', dependents: 2 },
      { nodeId: 'y', dependents: 1 },
    ]);
  });

  it('does not let a caller mutate the memoized hub list', () => {
    q.insertNodes([makeNode('a'), makeNode('b'), makeNode('t')]);
    q.insertEdges([makeEdge('a', 't'), makeEdge('b', 't')]);

    const first = q.getTopDependedOn(10);
    first[0]!.dependents = 999;
    first.push({ nodeId: 'injected', dependents: 1 });

    expect(q.getTopDependedOn(10)).toEqual([{ nodeId: 't', dependents: 2 }]);
  });

  it('drops both memos when the connection is rebound', () => {
    // Two databases whose change counts line up: 4 nodes + 3 edges and
    // 5 nodes + 1 edge each write the same number of rows (FTS triggers
    // included), so a fresh connection can report the same change stamp.
    q.insertNodes([makeNode('a'), makeNode('b'), makeNode('c'), makeNode('t')]);
    q.insertEdges([makeEdge('a', 't'), makeEdge('b', 't'), makeEdge('c', 't')]);
    expect(q.getTopDependedOn(10)).toEqual([{ nodeId: 't', dependents: 3 }]);
    expect(q.getStats().nodeCount).toBe(4);

    const other = DatabaseConnection.initialize(path.join(dir, 'other.db'));
    const otherQ = new QueryBuilder(other.getDb());
    otherQ.insertNodes([
      makeNode('v'),
      makeNode('w'),
      makeNode('x'),
      makeNode('y'),
      makeNode('z'),
    ]);
    otherQ.insertEdges([makeEdge('z', 'y')]);

    q.rebind(other.getDb());
    expect(q.getStats().nodeCount).toBe(5);
    expect(q.getTopDependedOn(10)).toEqual([{ nodeId: 'y', dependents: 1 }]);

    other.close();
  });

  it('does not keep a value read inside a rolled-back transaction', () => {
    q.insertNodes([makeNode('a')]);
    expect(q.getStats().nodeCount).toBe(1);
    expect(q.getTopDependedOn(10)).toEqual([]);

    const tx = db.getDb().transaction(() => {
      q.insertNodes([makeNode('b')]);
      q.insertEdges([makeEdge('b', 'a')]);
      // Inside the transaction the uncommitted rows are visible.
      expect(q.getStats().nodeCount).toBe(2);
      expect(q.getTopDependedOn(10)).toEqual([{ nodeId: 'a', dependents: 1 }]);
      throw new Error('rollback');
    });
    expect(tx).toThrow('rollback');

    // total_changes() is not reduced by the rollback, so a memo keyed only on
    // the stamp would still claim the rolled-back rows exist.
    expect(q.getStats().nodeCount).toBe(1);
    expect(q.getTopDependedOn(10)).toEqual([]);
  });

  it('caches getStats until the graph changes, and returns a safe copy', () => {
    q.insertNodes([makeNode('a'), makeNode('b')]);

    const first = q.getStats();
    expect(first.nodeCount).toBe(2);
    expect(first.edgesByKind.calls ?? 0).toBe(0);

    first.nodesByKind.function = 999;

    q.insertEdges([makeEdge('a', 'b')]);

    const second = q.getStats();
    expect(second.nodeCount).toBe(2);
    expect(second.edgeCount).toBe(1);
    expect(second.edgesByKind.calls).toBe(1);
    // The cached bucket was not corrupted by the earlier caller.
    expect(second.nodesByKind.function).toBe(2);
  });
});
