/**
 * Project identity: codegraph must file memory under the name Engram itself
 * would use, or one repository ends up split across two projects.
 *
 * Verified against Engram 3.5.2: `origin`'s repository name wins over the
 * directory name, a non-`origin` remote is ignored, and `ENGRAM_PROJECT` pins
 * the name outright.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import CodeGraph from '../../src/index';
import { deriveEngramProject, projectNameFromRemote } from '../../src/integrations/engram-sync';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

describe('projectNameFromRemote', () => {
  it.each([
    ['https://github.com/acme/remote-repo-name.git', 'remote-repo-name'],
    ['https://github.com/acme/remote-repo-name', 'remote-repo-name'],
    ['https://github.com/acme/remote-repo-name/', 'remote-repo-name'],
    ['git@github.com:acme/ssh-repo.git', 'ssh-repo'],
    ['ssh://git@github.com/acme/ssh-repo.git', 'ssh-repo'],
    ['https://gitlab.example.com/group/sub/deep.git', 'deep'],
    ['/srv/git/local-clone', 'local-clone'],
    ['file:///srv/git/local-clone.git', 'local-clone'],
    ['C:\\repos\\windows-clone', 'windows-clone'],
  ])('%s → %s', (url, expected) => {
    expect(projectNameFromRemote(url)).toBe(expected);
  });

  it('answers null when there is no usable name', () => {
    expect(projectNameFromRemote('')).toBeNull();
    expect(projectNameFromRemote('   ')).toBeNull();
    expect(projectNameFromRemote(null)).toBeNull();
    expect(projectNameFromRemote('.git')).toBeNull();
    expect(projectNameFromRemote('/')).toBeNull();
  });
});

describe('deriveEngramProject', () => {
  let base: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-project-id-'));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('falls back to the directory name outside git', () => {
    const dir = path.join(base, 'plain-dir');
    fs.mkdirSync(dir, { recursive: true });
    expect(deriveEngramProject(dir, {})).toBe('plain-dir');
  });

  it('honours a pinned ENGRAM_PROJECT without touching git', () => {
    const dir = path.join(base, 'pinned-dir');
    fs.mkdirSync(dir, { recursive: true });
    expect(deriveEngramProject(dir, { ENGRAM_PROJECT: 'pinned-name' })).toBe('pinned-name');
    expect(deriveEngramProject(dir, { ENGRAM_PROJECT: '   ' })).toBe('pinned-dir');
  });

  it.runIf(hasGit)('uses the origin remote name, not the checkout folder', () => {
    const dir = path.join(base, 'local-dir-name');
    fs.mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/remote-repo-name.git'],
      { cwd: dir, windowsHide: true });
    expect(deriveEngramProject(dir, {})).toBe('remote-repo-name');
  });

  it.runIf(hasGit)('ignores remotes other than origin', () => {
    const dir = path.join(base, 'upstream-only');
    fs.mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['remote', 'add', 'upstream', 'https://github.com/acme/upstream-target.git'],
      { cwd: dir, windowsHide: true });
    expect(deriveEngramProject(dir, {})).toBe('upstream-only');
  });
});

describe('the post-index hook files memory under that name', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-project-hook-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export function entry() { return 1; }\n');
    if (hasGit) {
      spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
      spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/hook-project-name.git'],
        { cwd: root, windowsHide: true });
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 30000);

  afterAll(async () => {
    await cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.ENGRAM_PROJECT;
    delete process.env.ENGRAM_URL;
  });

  it.runIf(hasGit)('traces the remote name, not the temp folder name', async () => {
    delete process.env.ENGRAM_PROJECT;
    // Dead port: the run must reach the trace without needing a server.
    process.env.ENGRAM_URL = 'http://127.0.0.1:59998';

    await cg.syncInsightsToEngram();

    const trace = fs.readFileSync(path.join(root, '.codegraph', 'engram-debug.jsonl'), 'utf8');
    const events = trace.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const synced = events.filter((e) => e.event === 'sync.done');
    expect(synced.length).toBeGreaterThan(0);
    for (const event of synced) expect(event.project).toBe('hook-project-name');
  });
});
