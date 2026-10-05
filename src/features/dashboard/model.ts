// Dashboard view model: words, icons, filters, search, sort and groups for the
// repository list. Pure functions over the IPC types so they are unit tested.

import type { IconName } from '../../components/Icon';
import type { AttentionLevel, AttentionReason, Reason, RepoSummary } from '../../ipc';

export interface LevelInfo {
  label: string;
  /** 0 is the most severe. */
  rank: number;
}

/** DESIGN.md attention categories, most severe first. */
export const LEVELS: Record<AttentionLevel, LevelInfo> = {
  risk: { label: 'At risk', rank: 0 },
  change: { label: 'Uncommitted', rank: 1 },
  sync: { label: 'Out of sync', rank: 2 },
  branch: { label: 'Loose ends', rank: 3 },
  clean: { label: 'Clean', rank: 4 },
};

export const LEVEL_ORDER: AttentionLevel[] = ['risk', 'change', 'sync', 'branch', 'clean'];

export type Filter = 'all' | 'attention' | 'risk' | 'change' | 'sync' | 'branch';
export type Sort = 'attention' | 'name' | 'recent';

export const FILTERS: { id: Filter; label: string; level: AttentionLevel | null }[] = [
  { id: 'all', label: 'All', level: null },
  { id: 'attention', label: 'Needs attention', level: null },
  { id: 'risk', label: LEVELS.risk.label, level: 'risk' },
  { id: 'change', label: LEVELS.change.label, level: 'change' },
  { id: 'sync', label: LEVELS.sync.label, level: 'sync' },
  { id: 'branch', label: LEVELS.branch.label, level: 'branch' },
];

export const SORTS: { id: Sort; label: string }[] = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'name', label: 'Name' },
  { id: 'recent', label: 'Last commit' },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The first line of a git message, without the `fatal: ` prefix. */
export function firstLine(message: string): string {
  const line = message.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return line.trim().replace(/^(fatal|error): /, '');
}

/** What a reason means, in the words of DESIGN.md. */
export function reasonText(reason: Reason): string {
  switch (reason.kind) {
    case 'scanError':
      return firstLine(reason.message) || 'Could not read the repository';
    case 'conflicts':
      return `${reason.count} conflicted`;
    case 'detachedHead':
      return 'Detached HEAD';
    case 'lostCommits':
      return plural(reason.count, 'lost commit', 'lost commits');
    case 'staged':
      return `${reason.count} staged`;
    case 'unstaged':
      return `${reason.count} modified`;
    case 'untracked':
      return `${reason.count} untracked`;
    case 'ahead':
      return `${reason.count} to push`;
    case 'behind':
      return `${reason.count} to pull`;
    case 'noUpstream':
      return 'No upstream';
    case 'upstreamGone':
      return 'Upstream deleted';
    case 'noRemote':
      return 'No remote';
    case 'unmergedBranches':
      return plural(reason.count, 'unmerged branch', 'unmerged branches');
    case 'stashes':
      return plural(reason.count, 'stash', 'stashes');
  }
}

export function reasonIcon(reason: Reason): IconName {
  switch (reason.kind) {
    case 'scanError':
    case 'conflicts':
      return 'alert';
    case 'detachedHead':
      return 'detached';
    case 'lostCommits':
      return 'lost';
    case 'staged':
    case 'untracked':
      return 'plus';
    case 'unstaged':
      return 'commit';
    case 'ahead':
      return 'up';
    case 'behind':
      return 'down';
    case 'noUpstream':
    case 'upstreamGone':
    case 'noRemote':
      return 'cloudOff';
    case 'unmergedBranches':
      return 'branch';
    case 'stashes':
      return 'stash';
  }
}

/** The state cell: the most severe reason and how many more there are. */
export function primaryReason(repo: RepoSummary): { reason: AttentionReason | null; more: number } {
  const [first, ...rest] = repo.attention.reasons;
  return { reason: first ?? null, more: rest.length };
}

/** Branch text for a row: the branch, `HEAD <hash>` when detached. */
export function branchLabel(repo: RepoSummary): string {
  const head = repo.head;
  if (!head) return '';
  switch (head.kind) {
    case 'branch':
      return head.name;
    case 'unborn':
      return `${head.name} (no commits)`;
    case 'detached':
      return `HEAD ${repo.oid ? repo.oid.slice(0, 7) : ''}`.trim();
  }
}

export const isWorktree = (repo: RepoSummary) => repo.kind.kind === 'linkedWorktree';

export interface Counts {
  staged: number;
  modified: number;
  untracked: number;
  ahead: number;
  behind: number;
  unmerged: number;
  stashes: number;
}

/** The seven count columns, left to right. */
export const COUNT_COLUMNS: { key: keyof Counts; head: string; icon?: IconName; name: string; title: string }[] = [
  { key: 'staged', head: 'A', name: 'Staged', title: 'Staged files' },
  { key: 'modified', head: 'M', name: 'Modified', title: 'Modified files' },
  { key: 'untracked', head: '?', name: 'Untracked', title: 'Untracked files' },
  { key: 'ahead', head: '↑', name: 'Ahead', title: 'Commits to push' },
  { key: 'behind', head: '↓', name: 'Behind', title: 'Commits to pull' },
  { key: 'unmerged', head: '', icon: 'branch', name: 'Unmerged branches', title: 'Branches not merged into the default branch' },
  { key: 'stashes', head: '', icon: 'stash', name: 'Stashes', title: 'Stashes' },
];

export function countsOf(repo: RepoSummary): Counts {
  return {
    staged: repo.counts.staged,
    modified: repo.counts.unstaged,
    untracked: repo.counts.untracked,
    ahead: repo.upstream?.ahead ?? 0,
    behind: repo.upstream?.behind ?? 0,
    unmerged: repo.unmergedBranches.length,
    stashes: repo.stashCount,
  };
}

/** Whether a repository has any reason in a category (not only its most severe one). */
export function hasLevel(repo: RepoSummary, level: AttentionLevel): boolean {
  if (level === 'clean') return !repo.attention.needsAttention;
  return repo.attention.reasons.some((r) => r.level === level);
}

export function matchesFilter(repo: RepoSummary, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'attention':
      return repo.attention.needsAttention;
    default:
      return hasLevel(repo, filter);
  }
}

/** Every term of the query matches the name, path or a branch (case-insensitive). */
export function matchesSearch(repo: RepoSummary, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    repo.name,
    repo.path,
    branchLabel(repo),
    ...repo.unmergedBranches.map((b) => b.name),
    ...repo.worktrees.map((w) => w.branch ?? ''),
  ]
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterCounts(repos: RepoSummary[]): Record<Filter, number> {
  const counts: Record<Filter, number> = { all: 0, attention: 0, risk: 0, change: 0, sync: 0, branch: 0 };
  for (const repo of repos) {
    for (const f of FILTERS) {
      if (matchesFilter(repo, f.id)) counts[f.id]++;
    }
  }
  return counts;
}

const byName = (a: RepoSummary, b: RepoSummary) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.path.localeCompare(b.path);

export function sortRepos(repos: RepoSummary[], sort: Sort): RepoSummary[] {
  const list = [...repos];
  switch (sort) {
    case 'attention':
      return list.sort((a, b) => LEVELS[a.attention.level].rank - LEVELS[b.attention.level].rank || byName(a, b));
    case 'name':
      return list.sort(byName);
    case 'recent':
      return list.sort((a, b) => (b.lastCommit?.time ?? -1) - (a.lastCommit?.time ?? -1) || byName(a, b));
  }
}

export interface Group {
  /** `null` when the list is not grouped. */
  level: AttentionLevel | null;
  label: string;
  repos: RepoSummary[];
}

export interface ListQuery {
  filter: Filter;
  query: string;
  sort: Sort;
  /** A repository listed whatever the filter and search (the one open in the repository view). */
  keep?: string | null;
}

/** The visible list: filtered, searched, sorted and grouped by attention when sorted by it. */
export function buildGroups(repos: RepoSummary[], { filter, query, sort, keep = null }: ListQuery): Group[] {
  const visible = sortRepos(
    repos.filter((r) => r.path === keep || (matchesFilter(r, filter) && matchesSearch(r, query))),
    sort,
  );
  if (!visible.length) return [];
  if (sort !== 'attention') {
    return [{ level: null, label: SORTS.find((s) => s.id === sort)?.label ?? '', repos: visible }];
  }
  return LEVEL_ORDER.map((level) => ({
    level,
    label: LEVELS[level].label,
    repos: visible.filter((r) => r.attention.level === level),
  })).filter((g) => g.repos.length > 0);
}

/** "3 minutes ago", relative to `nowMs`. Future times read as "just now". */
export function relativeTime(epochSeconds: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round(nowMs / 1000 - epochSeconds));
  if (seconds < 45) return 'just now';
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86_400, 'day'],
    [7 * 86_400, 'week'],
    [30 * 86_400, 'month'],
    [365 * 86_400, 'year'],
  ];
  let chosen = units[0]!;
  for (const unit of units) {
    if (seconds >= unit[0]) chosen = unit;
  }
  const n = Math.max(1, Math.round(seconds / chosen[0]));
  if (chosen[1] === 'day' && n === 1) return 'yesterday';
  return `${n} ${chosen[1]}${n === 1 ? '' : 's'} ago`;
}

/** Accessible name of a row: name, branch, state and every non-zero count. */
export function rowLabel(repo: RepoSummary): string {
  const parts = [repo.name];
  if (isWorktree(repo)) parts.push('worktree');
  const branch = branchLabel(repo);
  if (branch) parts.push(branch);
  if (repo.attention.reasons.length) {
    parts.push(repo.attention.reasons.map(reasonText).join(', '));
  } else {
    parts.push('clean');
  }
  return parts.join(', ');
}

/** Paths in visual order, for keyboard navigation. */
export const flatPaths = (groups: Group[]) => groups.flatMap((g) => g.repos.map((r) => r.path));
