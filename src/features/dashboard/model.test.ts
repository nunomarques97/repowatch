import { describe, expect, it } from 'vitest';
import { createMockClient } from '../../ipc/mock';
import type { Reason, RepoSummary } from '../../ipc';
import {
  branchLabel,
  buildGroups,
  countsOf,
  filterCounts,
  firstLine,
  flatPaths,
  matchesFilter,
  matchesSearch,
  reasonIcon,
  reasonText,
  relativeTime,
  rowLabel,
  sortRepos,
} from './model';

async function repos() {
  const snapshot = await createMockClient().scan();
  const repo = (name: string): RepoSummary => {
    const found = snapshot.repos.find((r) => r.name === name);
    if (!found) throw new Error(`no repo ${name}`);
    return found;
  };
  return { all: snapshot.repos, repo };
}

describe('dashboard model', () => {
  it('words every reason and gives it an icon', () => {
    const cases: [Reason, string][] = [
      [{ kind: 'scanError', message: 'fatal: bad config line 1\nmore' }, 'bad config line 1'],
      [{ kind: 'conflicts', count: 2 }, '2 conflicted'],
      [{ kind: 'detachedHead' }, 'Detached HEAD'],
      [{ kind: 'lostCommits', count: 1 }, '1 lost commit'],
      [{ kind: 'lostCommits', count: 3 }, '3 lost commits'],
      [{ kind: 'staged', count: 2 }, '2 staged'],
      [{ kind: 'unstaged', count: 3 }, '3 modified'],
      [{ kind: 'untracked', count: 1 }, '1 untracked'],
      [{ kind: 'ahead', count: 2 }, '2 to push'],
      [{ kind: 'behind', count: 4 }, '4 to pull'],
      [{ kind: 'noUpstream' }, 'No upstream'],
      [{ kind: 'upstreamGone' }, 'Upstream deleted'],
      [{ kind: 'noRemote' }, 'No remote'],
      [{ kind: 'unmergedBranches', count: 1 }, '1 unmerged branch'],
      [{ kind: 'stashes', count: 2 }, '2 stashes'],
    ];
    for (const [reason, text] of cases) {
      expect(reasonText(reason)).toBe(text);
      expect(reasonIcon(reason)).toBeTruthy();
    }
    expect(firstLine('\n  error: locked  \nnext')).toBe('locked');
    expect(reasonText({ kind: 'scanError', message: '' })).toBe('Could not read the repository');
  });

  it('labels branches, detached heads and unborn branches', async () => {
    const { repo } = await repos();
    expect(branchLabel(repo('api'))).toBe('feature/auth');
    expect(branchLabel(repo('legacy-app'))).toMatch(/^HEAD [0-9a-f]{7}$/);
    expect(branchLabel(repo('new-project'))).toBe('main (no commits)');
    expect(branchLabel(repo('broken-repo'))).toBe('');
  });

  it('counts the seven columns from the summary', async () => {
    const { repo } = await repos();
    const r = repo('repowatch');
    expect(countsOf(r)).toEqual({
      staged: r.counts.staged,
      modified: r.counts.unstaged,
      untracked: r.counts.untracked,
      ahead: 2,
      behind: 0,
      unmerged: r.unmergedBranches.length,
      stashes: 1,
    });
    expect(countsOf(repo('site')).behind).toBe(3);
    expect(countsOf(repo('design-system')).unmerged).toBe(2);
  });

  it('filters by any reason in a category, not only the most severe', async () => {
    const { all, repo } = await repos();
    // repowatch is "Uncommitted" first but also has commits to push.
    expect(repo('repowatch').attention.level).toBe('change');
    expect(matchesFilter(repo('repowatch'), 'sync')).toBe(true);
    expect(matchesFilter(repo('docs'), 'attention')).toBe(false);
    expect(matchesFilter(repo('docs'), 'all')).toBe(true);
    const counts = filterCounts(all);
    expect(counts.all).toBe(all.length);
    expect(counts.attention).toBe(all.filter((r) => r.attention.needsAttention).length);
    expect(counts.risk).toBe(all.filter((r) => r.attention.reasons.some((x) => x.level === 'risk')).length);
  });

  it('searches name, path and branches with every term', async () => {
    const { repo } = await repos();
    expect(matchesSearch(repo('api'), 'AUTH')).toBe(true);
    expect(matchesSearch(repo('api'), 'api feature')).toBe(true);
    expect(matchesSearch(repo('api'), 'api main')).toBe(false);
    expect(matchesSearch(repo('mobile'), 'documents\\work')).toBe(true);
    expect(matchesSearch(repo('repowatch'), 'feature/tray')).toBe(true);
    expect(matchesSearch(repo('docs'), '   ')).toBe(true);
  });

  it('groups by attention in severity order and keeps every visible repository once', async () => {
    const { all } = await repos();
    const groups = buildGroups(all, { filter: 'all', query: '', sort: 'attention' });
    expect(groups.map((g) => g.level)).toEqual(['risk', 'change', 'sync', 'branch', 'clean']);
    expect(flatPaths(groups).sort()).toEqual(all.map((r) => r.path).sort());
    for (const g of groups) {
      expect(g.repos.every((r) => r.attention.level === g.level)).toBe(true);
    }
    const attention = buildGroups(all, { filter: 'attention', query: '', sort: 'attention' });
    expect(attention.some((g) => g.level === 'clean')).toBe(false);
    expect(buildGroups(all, { filter: 'all', query: 'no such repository', sort: 'attention' })).toEqual([]);
  });

  it('sorts by name or last commit as one ungrouped list', async () => {
    const { all } = await repos();
    const byName = buildGroups(all, { filter: 'all', query: '', sort: 'name' });
    expect(byName).toHaveLength(1);
    expect(byName[0]!.level).toBeNull();
    const names = byName[0]!.repos.map((r) => r.name.toLowerCase());
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const recent = sortRepos(all, 'recent');
    const times = recent.map((r) => r.lastCommit?.time ?? -1);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('formats relative times', () => {
    const now = 1_000_000_000_000;
    const s = now / 1000;
    expect(relativeTime(s - 10, now)).toBe('just now');
    expect(relativeTime(s + 100, now)).toBe('just now');
    expect(relativeTime(s - 60, now)).toBe('1 minute ago');
    expect(relativeTime(s - 2 * 3600, now)).toBe('2 hours ago');
    expect(relativeTime(s - 86_400, now)).toBe('yesterday');
    expect(relativeTime(s - 3 * 86_400, now)).toBe('3 days ago');
    expect(relativeTime(s - 21 * 86_400, now)).toBe('3 weeks ago');
    expect(relativeTime(s - 90 * 86_400, now)).toBe('3 months ago');
    expect(relativeTime(s - 400 * 86_400, now)).toBe('1 year ago');
  });

  it('names rows with their state for assistive technology', async () => {
    const { repo } = await repos();
    expect(rowLabel(repo('docs'))).toBe('docs, main, clean');
    expect(rowLabel(repo('repowatch-tray'))).toContain('worktree');
    expect(rowLabel(repo('forja'))).toBe('forja, main, 4 to push');
  });
});
