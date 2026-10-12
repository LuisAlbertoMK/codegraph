# Cross-machine check: OLD vs NEW engine on your own projects

Portable recipe to reproduce the OLD-vs-NEW engine comparison on any box.
It measures **cold-index wall time + insight-extraction wall time** per dist
build, always on a temp copy — your projects are never indexed or modified,
and nothing is written to Engram.

## Requirements

- Node **22.5 – 24.x** (`node --version`; v25 refuses to start, <22.5 has no `node:sqlite`).
- Git + ~10 min for two `npm ci` + `npm run build`.

## 1. Build both arms

```bash
git clone -b feature/codegraph-engram-integration <repo-url> codegraph-new
cd codegraph-new && npm ci && npm run build && cd ..

git clone <repo-url> codegraph-old
cd codegraph-old && git checkout 144c5f7 && npm ci && npm run build && cd ..
```

`144c5f7` is the last pre-perf commit (parent of the first perf change);
`feature/codegraph-engram-integration` HEAD is the NEW arm.

## 2. Run the battery (per arm, per project)

```bash
node codegraph-new/scripts/benchmark-cross-machine.mjs \
  --dist codegraph-new/dist --project <path-to-project> --label <name>-new

node codegraph-new/scripts/benchmark-cross-machine.mjs \
  --dist codegraph-old/dist --project <path-to-project> --label <name>-old
```

Defaults: `--index-runs 2 --extract-runs 10` (extract is the sensitive one;
index mostly measures startup+scan). Each run prints one JSON block with
`p50`/`p95`/`min`/`max` plus a file/node/edge census. Work copies stay under
the OS temp dir — delete them when done.

Optional read-only memory check (needs Engram on `:7437`, never writes):

```bash
... --mem-runs 20 --engram-url http://127.0.0.1:7437
```

## 3. Compare honestly

- Report **medians (+p95)**, never means alone — box variance is ±25–40%.
- Run both arms back-to-back on an **idle** box and state the conditions
  (CPU, what else was running). Our reference runs were partly contaminated
  by 3 concurrent batteries and still converged — declare yours.
- Compare **per-node** too (`extract_ms.p50 / census.nodes`): corpus size
  differs per project, wall-clock alone misleads.
- `index_ms` is startup+scan dominated; the perf change targets extraction,
  so expect index to read as noise (±10–20%).

## Reference (our 17-project run, 2026-10-12)

Extract NEW faster-or-flat everywhere, **1.2–4.4x median** depending on graph
size (small ~2x, medium ~2–3x, large real-code repos 3–4.4x); index noise;
identical insight counts except ±2 on XL corpora (insight pool 200→100).
Full table in the session notes; steady-state sync 0–1ms with zero network
and live memory search ~30ms were verified separately against real Engram.
