/**
 * `hasSynthesisPattern` is the per-file content sniff that decides whether a file
 * can take part in any callback-synthesis pass. It runs on EVERY indexed file
 * (src/index.ts, and again in `collectInputs`), so its cost is paid once per file
 * of the whole repository — it has to stay linear in the file's length.
 *
 * Two of the patterns it tests (the MediatR `.Send(`/`.Publish(` dispatch and the
 * Sidekiq `Worker.perform_async` dispatch) matched a dotted receiver with a
 * character run followed by a REQUIRED `.`, with no left boundary:
 *
 *     ([A-Za-z_][\w.]*)\s*\.\s*(?:Send|Publish)...
 *
 * On a file whose line is one long token — exactly what minified bundles,
 * vendored blobs and base64 fixtures look like — the engine consumes the whole
 * run, fails on `.`, backtracks one character, and retries from the next start
 * position: O(n²). Measured on this repo's build: 26 s for a single 100 KB token,
 * which is what made `codegraph index` appear to hang on a one-line 200 KB file.
 *
 * The fix adds a left boundary (`(?<![\w.])`) so every start position inside the
 * token is rejected in constant time. The patterns keep matching the same sites:
 * the first test below is the semantic guard, the second is the cost guard.
 */
import { describe, it, expect } from 'vitest';
import { hasSynthesisPattern } from '../src/resolution/callback-synthesizer';

const TOKEN = 100_000;
/** Wall-clock bound with a wide margin: the fix needs ~0 ms, the defect ~26 s. */
const BUDGET_MS = 2_000;

function timeScan(filePath: string, content: string): { elapsed: number; answer: boolean } {
  const start = Date.now();
  const answer = hasSynthesisPattern(filePath, content);
  return { elapsed: Date.now() - start, answer };
}

describe('hasSynthesisPattern — content sniff stays linear', () => {
  it('still detects the dispatch shapes it gated before', () => {
    expect(hasSynthesisPattern('OrderController.cs', 'await _mediator.Send(new CancelOrderCommand(id));')).toBe(true);
    expect(hasSynthesisPattern('OrderController.cs', 'await _mediator.Publish(new OrderShippedNotification(id));')).toBe(true);
    expect(hasSynthesisPattern('app/workers/hard_worker.rb', 'MyWorker.perform_async(1, 2)')).toBe(true);
    // A receiver that is not mediator-ish still reaches the sniff: the pass
    // itself decides precision, the sniff only answers "could this file have a
    // dispatch site at all?".
    expect(hasSynthesisPattern('x.cs', 'MessagingCenter.Send(this, "x");')).toBe(true);
  });

  it('does not blow up on a file that is one long token', () => {
    for (const content of ['a'.repeat(TOKEN), 'A'.repeat(TOKEN), 'a.'.repeat(TOKEN >> 1)]) {
      const { elapsed, answer } = timeScan('bundle.js', content);
      expect(answer).toBe(false);
      expect(elapsed, `${content.length} chars of a single token took ${elapsed}ms`).toBeLessThan(BUDGET_MS);
    }
  });

  it('does not blow up on a long dotted receiver with a dispatch site at the end', () => {
    // The pathological shape that matched before the fix: the run is followed by
    // a real `.Send(`, so the pattern does match — it must still find it fast.
    const content = 'a.'.repeat(TOKEN >> 3) + 'Send(x);';
    const { elapsed, answer } = timeScan('bundle.js', content);
    expect(answer).toBe(true);
    expect(elapsed, `${content.length} chars took ${elapsed}ms`).toBeLessThan(BUDGET_MS);
  });
});
