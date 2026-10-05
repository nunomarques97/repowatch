import { describe, expect, it } from 'vitest';
import { IpcError } from './client';
import { createMockClient, type MockClient } from './mock';
import { DOCUMENTS } from './mock-data';
import type { CommandError, RepoSummary, ScanSnapshot } from './types';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function rejection(promise: Promise<unknown>): Promise<CommandError> {
  const reason = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
  expect(reason).toBeInstanceOf(IpcError);
  return (reason as IpcError).error;
}

async function scanned(scenario: Parameters<typeof createMockClient>[0] = {}) {
  const mock = createMockClient(scenario);
  const snapshot = await mock.scan();
  const repo = (name: string): RepoSummary => {
    const found = snapshot.repos.find((r) => r.name === name);
    if (!found) throw new Error(`no repo ${name}`);
    return found;
  };
  return { mock, snapshot, repo };
}

async function current(mock: MockClient, name: string): Promise<RepoSummary> {
  const snapshot = await mock.getSnapshot();
  const found = snapshot?.repos.find((r) => r.name === name);
  if (!found) throw new Error(`no repo ${name}`);
  return found;
}

describe('mock client', () => {
  it('scans the default scenario in attention order with every category', async () => {
    const { snapshot, repo } = await scanned();
    const levels = snapshot.repos.map((r) => r.attention.level);
    const rank = ['clean', 'branch', 'sync', 'change', 'risk'];
    expect([...levels].sort((a, b) => rank.indexOf(b) - rank.indexOf(a))).toEqual(levels);
    expect(new Set(levels)).toEqual(new Set(rank));
    expect(snapshot.attentionCount).toBe(snapshot.repos.filter((r) => r.attention.needsAttention).length);
    expect(repo('broken-repo').error?.kind).toBe('failed');
    expect(repo('legacy-app').head).toEqual({ kind: 'detached' });
    expect(repo('repowatch-tray').kind.kind).toBe('linkedWorktree');
    expect(repo('repowatch').worktrees).toHaveLength(2);
    expect(repo('new-project').head?.kind).toBe('unborn');
    expect(repo('mobile').upstream?.gone).toBe(true);
    expect(repo('playground').lostCommits).toBeNull();
    const kinds = new Set(snapshot.repos.flatMap((r) => r.attention.reasons.map((reason) => reason.kind)));
    for (const kind of [
      'scanError',
      'conflicts',
      'detachedHead',
      'staged',
      'unstaged',
      'untracked',
      'ahead',
      'behind',
      'noUpstream',
      'upstreamGone',
      'noRemote',
      'unmergedBranches',
      'stashes',
    ]) {
      expect(kinds, kind).toContain(kind);
    }
  });

  it('has empty, no-repository, many and error scenarios', async () => {
    const empty = await createMockClient({ scenario: 'empty' }).scan();
    expect(empty.roots).toEqual([]);
    expect(empty.repos).toEqual([]);
    const none = await createMockClient({ scenario: 'noRepos' }).scan();
    expect(none.roots.length).toBeGreaterThan(0);
    expect(none.repos).toEqual([]);
    expect((await createMockClient({ scenario: 'many' }).scan()).repos).toHaveLength(50);
    const errors = await createMockClient({ scenario: 'errors' }).scan();
    expect(errors.issues).toHaveLength(1);
    expect(errors.repos.filter((r) => r.error)).toHaveLength(2);
  });

  it('acts only on repositories of the last scan', async () => {
    const mock = createMockClient();
    const path = 'C:\\Users\\dev\\Desktop\\Repositorios\\forja';
    expect((await rejection(mock.repoDetail(path))).kind).toBe('unknownRepo');
    await mock.scan();
    await mock.repoDetail(path);
    for (const other of [`${path}\\src`, path.toUpperCase(), `${path}\\`, '', 'C:\\elsewhere']) {
      expect((await rejection(mock.repoDetail(other))).kind).toBe('unknownRepo');
      expect((await rejection(mock.push(other))).kind).toBe('unknownRepo');
    }
  });

  it('coalesces overlapping scans into one follow-up scan', async () => {
    const mock = createMockClient({ latencyMs: 5 });
    const results = await Promise.all([mock.scan(), mock.scan(), mock.scan(), mock.scan()]);
    expect(results.map((s) => s.generation)).toEqual([1, 2, 2, 2]);
    const statuses: boolean[] = [];
    mock.onStatus((status) => statuses.push(status.scanning));
    await mock.scan();
    await tick();
    expect(statuses).toEqual([true, false]);
  });

  it('stages, commits and pushes with refreshed snapshots in generation order', async () => {
    const { mock, repo } = await scanned();
    const path = repo('repowatch').path;
    const generations: number[] = [];
    mock.onSnapshot((s) => generations.push(s.generation));

    await mock.stageFile(path, 'README.md');
    let detail = await mock.repoDetail(path);
    expect(detail.status.entries.find((e) => e.path === 'README.md')?.index).toBe('modified');

    const diff = await mock.fileDiff(path, 'src/App.tsx', 'unstaged');
    expect(diff.hunks).toHaveLength(2);
    await mock.stageHunk(path, 'src/App.tsx', diff.hunks[0]!.id);
    const entry = (await mock.repoDetail(path)).status.entries.find((e) => e.path === 'src/App.tsx');
    expect([entry?.index, entry?.worktree]).toEqual(['modified', 'modified']);
    expect((await rejection(mock.stageHunk(path, 'src/App.tsx', diff.hunks[0]!.id))).kind).toBe('git');

    await mock.commit(path, 'Ship it');
    const afterCommit = await current(mock, 'repowatch');
    expect(afterCommit.counts.staged).toBe(0);
    expect(afterCommit.upstream?.ahead).toBe(3);
    expect(afterCommit.lastCommit?.subject).toBe('Ship it');

    await mock.push(path);
    expect((await current(mock, 'repowatch')).upstream?.ahead).toBe(0);
    detail = await mock.repoDetail(path);
    expect(detail.status.counts.staged).toBe(0);
    await tick();
    expect(generations.length).toBeGreaterThanOrEqual(5);
    expect([...generations].sort((a, b) => a - b)).toEqual(generations);
  });

  it('refuses a second action on a repository while one is pending', async () => {
    const { mock, repo } = await scanned();
    const path = repo('forja').path;
    mock.pause('push');
    const first = mock.push(path);
    const second = await rejection(mock.push(path));
    expect(second).toEqual({ kind: 'busy', path });
    // Another repository is not blocked.
    await mock.fetch(repo('site').path);
    mock.resume('push');
    await first;
    await mock.push(path);
  });

  it('injects failures and still refreshes after a failed action', async () => {
    const { mock, repo } = await scanned();
    const path = repo('docs').path;
    const before = (await mock.getSnapshot())!.generation;
    mock.failNext('fetch', { kind: 'git', error: { kind: 'failed', code: 128, stderr: 'fatal: unable to access' } });
    const error = await rejection(mock.fetch(path));
    expect(error).toEqual({ kind: 'git', error: { kind: 'failed', code: 128, stderr: 'fatal: unable to access' } });
    expect((await mock.getSnapshot())!.generation).toBeGreaterThan(before);
    await mock.fetch(path);
  });

  it('follows the safety rules of pull, push, branches and stashes', async () => {
    const { mock, repo } = await scanned();
    const pipeline = repo('data-pipeline').path;
    expect(await rejection(mock.pull(pipeline))).toEqual({ kind: 'git', error: { kind: 'notFastForward' } });
    const site = repo('site').path;
    expect((await rejection(mock.push(site))).kind).toBe('git');
    await mock.pull(site);
    expect((await current(mock, 'site')).attention.level).toBe('clean');
    expect(await rejection(mock.push(repo('legacy-app').path))).toEqual({ kind: 'git', error: { kind: 'detachedHead' } });
    expect(await rejection(mock.fetch(repo('notes').path))).toEqual({ kind: 'git', error: { kind: 'noRemote' } });
    expect((await rejection(mock.repoDetail(repo('broken-repo').path))).kind).toBe('git');

    const ds = repo('design-system').path;
    expect(await rejection(mock.deleteBranch(ds, 'feature/tokens'))).toEqual({
      kind: 'git',
      error: { kind: 'branchNotMerged', branch: 'feature/tokens' },
    });
    expect((await rejection(mock.deleteBranch(ds, 'main'))).kind).toBe('git');
    expect((await rejection(mock.createBranch(ds, '-f'))).kind).toBe('git');
    expect((await rejection(mock.createBranch(ds, 'old/merged'))).kind).toBe('git');
    await mock.deleteBranch(ds, 'old/merged');
    await mock.createBranch(ds, 'feature/new');
    await mock.switchBranch(ds, 'feature/new');
    expect((await current(mock, 'design-system')).head).toEqual({ kind: 'branch', name: 'feature/new' });

    const stashes = (await mock.repoDetail(ds)).stashes;
    expect(await rejection(mock.dropStash(ds, 0, stashes[1]!.oid))).toEqual({
      kind: 'git',
      error: { kind: 'stale', what: 'the stash list' },
    });
    await mock.applyStash(ds, 0, stashes[0]!.oid);
    await mock.dropStash(ds, 0, stashes[0]!.oid);
    const left = (await mock.repoDetail(ds)).stashes;
    expect(left).toEqual([{ ...stashes[1]!, index: 0 }]);
  });

  it('counts lost commits on demand and recovers one', async () => {
    const { mock, repo } = await scanned();
    const path = repo('playground').path;
    const lost = await mock.lostCommits(path);
    expect(lost.windowDays).toBe(30);
    expect(lost.commits).toHaveLength(2);
    const summary = await current(mock, 'playground');
    expect(summary.lostCommits).toBe(2);
    expect(summary.attention.level).toBe('risk');
    await mock.recoverCommit(path, lost.commits[0]!.oid, 'rescued');
    expect((await current(mock, 'playground')).lostCommits).toBe(1);
    expect((await mock.repoDetail(path)).branches.branches.map((b) => b.name)).toContain('rescued');
    expect((await rejection(mock.recoverCommit(path, 'abc', 'x'))).kind).toBe('git');
  });

  it('validates settings, emits them and rescans when roots change', async () => {
    const { mock, snapshot } = await scanned();
    const settings = await mock.getSettings();
    expect(settings.backgroundFetch.enabled).toBe(false);
    const invalid = await rejection(mock.updateSettings({ ...settings, roots: ['relative'] }));
    expect(invalid).toMatchObject({ kind: 'invalidSettings', field: 'roots' });
    expect(
      await rejection(mock.updateSettings({ ...settings, backgroundFetch: { enabled: true, intervalMinutes: 1 } })),
    ).toMatchObject({ field: 'backgroundFetch.intervalMinutes' });

    const seen: string[][] = [];
    const snapshots: ScanSnapshot[] = [];
    mock.onSettings((s) => seen.push(s.roots));
    mock.onSnapshot((s) => snapshots.push(s));
    const saved = await mock.updateSettings({ ...settings, roots: [`  ${DOCUMENTS}  `, DOCUMENTS.toLowerCase()] });
    expect(saved.roots).toEqual([DOCUMENTS]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([[DOCUMENTS]]);
    const rescanned = snapshots.at(-1)!;
    expect(rescanned.repos.length).toBeLessThan(snapshot.repos.length);
    expect(rescanned.repos.every((r) => r.path.startsWith(DOCUMENTS))).toBe(true);
    // A repository outside the new roots is refused.
    expect((await rejection(mock.repoDetail(snapshot.repos.find((r) => !r.path.startsWith(DOCUMENTS))!.path))).kind).toBe(
      'unknownRepo',
    );
  });

  it('hands out copies', async () => {
    const { mock } = await scanned();
    const first = (await mock.getSnapshot())!;
    first.repos[0]!.name = 'mutated';
    first.repos.length = 0;
    const again = (await mock.getSnapshot())!;
    expect(again.repos.length).toBeGreaterThan(0);
    expect(again.repos[0]!.name).not.toBe('mutated');
  });

  it('records calls, opens repositories and picks folders', async () => {
    const { mock, repo } = await scanned();
    await mock.openRepo(repo('forja').path, 'terminal');
    expect((await rejection(mock.openRepo('C:\\nope', 'vsCode'))).kind).toBe('unknownRepo');
    expect(await mock.pickFolder()).toBe('C:\\Users\\dev\\Projects');
    mock.setPickedFolder(null);
    expect(await mock.pickFolder()).toBeNull();
    expect(mock.calls.map((c) => c.command)).toEqual(['scan', 'openRepo', 'openRepo', 'pickFolder', 'pickFolder']);
  });

  it('reports a change on disk as a refresh', async () => {
    const { mock, repo } = await scanned();
    const path = repo('docs').path;
    const snapshots: ScanSnapshot[] = [];
    mock.onSnapshot((s) => snapshots.push(s));
    mock.touch(path, 'guide.md');
    await tick();
    expect(snapshots.at(-1)!.repos.find((r) => r.path === path)!.counts.unstaged).toBe(1);
  });
});
