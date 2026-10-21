# Fork notes

This repository is a fork of [`colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph); `README.md` describes the project itself. Nothing in this file exists upstream. It records the few things that are true only of this fork, so a future sync does not have to rediscover them.

## `main` runs its own CI

`.github/workflows/ci.yml` is fork-owned. Upstream's `main` ships only `deploy-site.yml` and `release.yml` under `.github/workflows/` — their Actions tab lists more workflows, but those come from other branches, which is why a repo-wide listing shows a `CI` entry that `main` has no file for. If upstream ever puts a file back at that path, expect a conflict in this one file.

It runs on pushes to `main` and on pull requests: `npm ci`, `npx tsc --noEmit`, `npm run build`, then vitest.

## `Deploy site to GitHub Pages` is disabled

State: `disabled_manually`, set with

```
gh workflow disable "Deploy site to GitHub Pages" --repo LuisAlbertoMK/codegraph
```

The file is untouched — it is byte-identical to upstream's, and editing it would earn a diff against an upstream-owned file on every sync.

It failed the first time it ever ran here (merge `ded9e66c`): the Astro build succeeded and produced its artifact, then `actions/deploy-pages@v4` returned `HttpError: Not Found`, because GitHub Pages is not enabled in this fork.

Enabling Pages would not publish this fork's site. `site/astro.config.mjs` hardcodes upstream's canonical URLs — `site: 'https://colbymchenry.github.io'`, `base: '/codegraph'` — so the copy published here would be upstream-branded and mis-canonicalized. The failure stays on `ded9e66c` and cannot be re-run while the workflow is disabled; `main` reads clean from the next commit onward. Nothing depends on this workflow: no `workflow_run` triggers exist anywhere in the repo, and `release.yml` runs on `workflow_dispatch` and `release:` only.

### Re-check after every upstream sync

The disable does **not** survive a rename or a delete-and-re-add of the workflow file: GitHub registers a new workflow entry, which starts `active`, and the next push touching `site/**` goes red again with no obvious cause.

```
gh workflow list --all --repo LuisAlbertoMK/codegraph
```
