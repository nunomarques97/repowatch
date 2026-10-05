// Repository detail view model: file rows from `git status`, the words of
// every git action (pending, done, failed) and the confirmations of the ones
// that need them (DESIGN.md "Confirmation dialog"). Pure, so it is unit tested.

import type { Branch, DiffSide, FileChange, LostCommit, OpenTarget, RepoDetail, Stash, StatusEntry } from '../../ipc';

export interface FileRow {
  /** Unique in the list: the side and the path. */
  key: string;
  path: string;
  originalPath: string | null;
  side: DiffSide;
  /** `git status` letter: M, A, D, R, T, C, U or `?`. */
  letter: string;
  /** The letter in words, for the accessible name. */
  change: string;
  conflicted: boolean;
}

export interface FileLists {
  staged: FileRow[];
  changes: FileRow[];
}

const LETTERS: Record<FileChange, [string, string]> = {
  unmodified: [' ', 'Unmodified'],
  modified: ['M', 'Modified'],
  typeChanged: ['T', 'Type changed'],
  added: ['A', 'Added'],
  deleted: ['D', 'Deleted'],
  renamed: ['R', 'Renamed'],
  copied: ['C', 'Copied'],
  unmerged: ['U', 'Conflicted'],
};

export const fileKey = (side: DiffSide, path: string) => `${side}:${path}`;

function row(entry: StatusEntry, side: DiffSide, change: FileChange): FileRow {
  const [letter, words] = side === 'untracked' ? ['?', 'Untracked'] : LETTERS[change];
  return {
    key: fileKey(side, entry.path),
    path: entry.path,
    originalPath: side === 'staged' ? entry.originalPath : null,
    side,
    letter,
    change: words,
    conflicted: entry.kind === 'conflicted',
  };
}

/** Staged files, then the working tree's changes (conflicts, modified, untracked), as `git status` lists them. */
export function fileLists(entries: readonly StatusEntry[]): FileLists {
  const staged: FileRow[] = [];
  const changes: FileRow[] = [];
  for (const entry of entries) {
    if (entry.kind === 'untracked') {
      changes.push(row(entry, 'untracked', 'added'));
    } else if (entry.kind === 'conflicted') {
      changes.push(row(entry, 'unstaged', 'unmerged'));
    } else {
      if (entry.index !== 'unmodified') staged.push(row(entry, 'staged', entry.index));
      if (entry.worktree !== 'unmodified') changes.push(row(entry, 'unstaged', entry.worktree));
    }
  }
  const order = (a: FileRow, b: FileRow) => Number(b.conflicted) - Number(a.conflicted) || a.path.localeCompare(b.path);
  return { staged: staged.sort(order), changes: changes.sort(order) };
}

/**
 * The file to show after the list changed. The same row when it is still
 * there. Otherwise, with `follow: 'path'`, the same file on the other side
 * (a file staged from its diff stays in view, now under "Staged"); with
 * `follow: 'position'`, the row that took its place (staging files one after
 * another from the list); then the row at the same position, else none.
 */
export function nextSelection(
  previous: readonly FileRow[],
  next: readonly FileRow[],
  key: string | null,
  follow: 'path' | 'position' = 'path',
): string | null {
  if (!next.length) return null;
  if (key === null) return next[0]!.key;
  if (next.some((r) => r.key === key)) return key;
  const index = previous.findIndex((r) => r.key === key);
  if (index < 0) return next[0]!.key;
  if (follow === 'path') {
    const moved = next.find((r) => r.path === previous[index]!.path);
    if (moved) return moved.key;
  }
  // The rows of the same list after it, then before it, that are still there.
  const side = previous[index]!.side === 'staged';
  const sameList = (r: FileRow) => (r.side === 'staged') === side && next.some((n) => n.key === r.key);
  const after = previous.slice(index + 1).find(sameList) ?? previous.slice(0, index).reverse().find(sameList);
  if (after) return after.key;
  return next[Math.min(index, next.length - 1)]!.key;
}

/** Folder and file name of a path, so the folder can truncate before the name. */
export function splitPath(path: string): { dir: string; base: string } {
  const folder = path.endsWith('/');
  const parts = path.replace(/\/$/, '').split('/');
  const base = parts.pop() ?? path;
  return { dir: parts.length ? `${parts.join('/')}/` : '', base: folder ? `${base}/` : base };
}

export const shortOid = (oid: string) => oid.slice(0, 7);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Git actions

export type DetailAction =
  | { kind: 'stageFile'; path: string }
  | { kind: 'unstageFile'; path: string }
  | { kind: 'stageHunk'; path: string; hunkId: string }
  | { kind: 'unstageHunk'; path: string; hunkId: string }
  | { kind: 'commit'; message: string; files: number }
  | { kind: 'fetch' }
  | { kind: 'pull'; branch: string; upstream: string }
  | { kind: 'push'; branch: string; target: string; commits: number }
  | { kind: 'createBranch'; name: string }
  | { kind: 'switchBranch'; name: string }
  | { kind: 'deleteBranch'; name: string }
  | { kind: 'applyStash'; index: number; oid: string }
  | { kind: 'dropStash'; index: number; oid: string }
  | { kind: 'recoverCommit'; oid: string; branch: string }
  | { kind: 'open'; target: OpenTarget };

export type ActionKind = DetailAction['kind'];

const OPEN_NAMES: Record<OpenTarget, string> = { vsCode: 'VS Code', terminal: 'the terminal', fileManager: 'Explorer' };

const stash = (index: number) => `stash@{${index}}`;

/** What the action says while it runs, when it worked and when it failed (the git error follows). */
export function actionWords(action: DetailAction): { pending: string; done: string; failed: string } {
  switch (action.kind) {
    case 'stageFile':
      return { pending: `Staging ${action.path}…`, done: `Staged ${action.path}.`, failed: `${action.path} was not staged.` };
    case 'unstageFile':
      return { pending: `Unstaging ${action.path}…`, done: `Unstaged ${action.path}.`, failed: `${action.path} was not unstaged.` };
    case 'stageHunk':
      return { pending: `Staging a hunk of ${action.path}…`, done: `Staged a hunk of ${action.path}.`, failed: 'The hunk was not staged.' };
    case 'unstageHunk':
      return { pending: `Unstaging a hunk of ${action.path}…`, done: `Unstaged a hunk of ${action.path}.`, failed: 'The hunk was not unstaged.' };
    case 'commit':
      return {
        pending: `Committing ${plural(action.files, 'file', 'files')}…`,
        done: `Committed ${plural(action.files, 'file', 'files')}: ${firstLine(action.message)}`,
        failed: 'Nothing was committed.',
      };
    case 'fetch':
      return { pending: 'Fetching from every remote…', done: 'Fetched. Local branches did not change.', failed: 'Fetch failed.' };
    case 'pull':
      return {
        pending: `Pulling ${action.upstream} into ${action.branch}…`,
        done: `Pulled ${action.upstream} into ${action.branch} (fast-forward).`,
        failed: `${action.branch} was not updated.`,
      };
    case 'push':
      return {
        pending: `Pushing ${action.branch} to ${action.target}…`,
        done: action.commits
          ? `Pushed ${plural(action.commits, 'commit', 'commits')} to ${action.target}.`
          : `Pushed ${action.branch} to ${action.target}.`,
        failed: `${action.branch} was not pushed.`,
      };
    case 'createBranch':
      return { pending: `Creating branch ${action.name}…`, done: `Created branch ${action.name}.`, failed: `Branch ${action.name} was not created.` };
    case 'switchBranch':
      return { pending: `Switching to ${action.name}…`, done: `Switched to ${action.name}.`, failed: `Still on the previous branch; ${action.name} was not checked out.` };
    case 'deleteBranch':
      return { pending: `Deleting branch ${action.name}…`, done: `Deleted branch ${action.name}.`, failed: `Branch ${action.name} was not deleted.` };
    case 'applyStash':
      return { pending: `Applying ${stash(action.index)}…`, done: `Applied ${stash(action.index)}; the stash is kept.`, failed: `${stash(action.index)} was not applied.` };
    case 'dropStash':
      return { pending: `Dropping ${stash(action.index)}…`, done: `Dropped ${stash(action.index)}.`, failed: `${stash(action.index)} was not dropped.` };
    case 'recoverCommit':
      return {
        pending: `Recovering ${shortOid(action.oid)} to ${action.branch}…`,
        done: `Recovered ${shortOid(action.oid)} to branch ${action.branch}.`,
        failed: `${shortOid(action.oid)} was not recovered.`,
      };
    case 'open':
      return { pending: `Opening in ${OPEN_NAMES[action.target]}…`, done: `Opened in ${OPEN_NAMES[action.target]}.`, failed: `Not opened in ${OPEN_NAMES[action.target]}.` };
  }
}

function firstLine(message: string): string {
  return message.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
}

// Confirmations

export type ConfirmTone = 'ink' | 'danger';

export interface Confirmation {
  title: string;
  /** The exact consequence and how to undo it. */
  body: string;
  /** The action's own verb, on the confirm button. */
  verb: string;
  tone: ConfirmTone;
}

export interface ConfirmContext {
  defaultBranch: string | null;
  branches: readonly Branch[];
  stashes: readonly Stash[];
  lost: readonly LostCommit[];
  windowDays: number;
}

/** The confirmation an action needs, or `null` when it runs at once. */
export function confirmation(action: DetailAction, ctx: ConfirmContext): Confirmation | null {
  switch (action.kind) {
    case 'push':
      return {
        title: `Push ${action.branch} to ${action.target}?`,
        body:
          (action.commits
            ? `Sends ${plural(action.commits, 'commit', 'commits')} on ${action.branch} to ${action.target}.`
            : `Publishes ${action.branch} as ${action.target} and makes it the upstream.`) +
          ' Nothing is forced: if the remote has commits you do not have, the push is rejected and nothing changes.',
        verb: 'Push',
        tone: 'ink',
      };
    case 'deleteBranch': {
      const branch = ctx.branches.find((b) => b.name === action.name);
      const main = ctx.defaultBranch ?? 'the default branch';
      return {
        title: `Delete branch ${action.name}?`,
        body:
          `Removes the local branch ${action.name}. Its commits are merged into ${main}, so none are lost.` +
          (branch ? ` To undo, create a branch at ${shortOid(branch.oid)}.` : '') +
          (branch?.upstream ? ` ${branch.upstream} on the remote is not touched.` : ''),
        verb: 'Delete branch',
        tone: 'danger',
      };
    }
    case 'applyStash': {
      const found = ctx.stashes.find((s) => s.index === action.index);
      return {
        title: `Apply ${stash(action.index)}?`,
        body:
          `Merges “${found?.message ?? stash(action.index)}” into the working tree. The stash is kept, so you can drop it afterwards.` +
          ' If a changed file would be overwritten, git stops and nothing is applied.',
        verb: 'Apply stash',
        tone: 'ink',
      };
    }
    case 'dropStash': {
      const found = ctx.stashes.find((s) => s.index === action.index);
      return {
        title: `Drop ${stash(action.index)}?`,
        body:
          `Deletes “${found?.message ?? stash(action.index)}” from the stash list.` +
          ` Its commit stays under Lost commits (for ${plural(ctx.windowDays, 'day', 'days')} in this view, until git prunes it), where you can recover it to a branch.`,
        verb: 'Drop stash',
        tone: 'danger',
      };
    }
    case 'recoverCommit': {
      const found = ctx.lost.find((c) => c.oid === action.oid);
      return {
        title: `Recover ${shortOid(action.oid)} to a new branch?`,
        body:
          `Creates a branch at ${shortOid(action.oid)}${found ? ` “${found.subject}”` : ''}. The current branch and the working tree do not change.` +
          ' To undo, delete the new branch.',
        verb: 'Recover to branch',
        tone: 'ink',
      };
    }
    default:
      return null;
  }
}

/** A branch name for a recovered commit that does not exist yet. */
export function recoverBranchName(oid: string, branches: readonly Branch[]): string {
  const base = `recovered/${shortOid(oid)}`;
  const taken = new Set(branches.map((b) => b.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

/**
 * Why a branch name cannot be used, checked before asking git (which checks
 * again); `null` when it looks valid. Mirrors the common `check-ref-format` rules.
 */
export function branchNameProblem(name: string): string | null {
  if (!name.trim()) return 'Enter a branch name.';
  if (name !== name.trim() || /\s/.test(name)) return 'A branch name cannot contain spaces.';
  if (name.startsWith('-')) return 'A branch name cannot start with "-".';
  if (/[~^:?*[\\]/.test(name) || [...name].some((c) => c < ' ' || c === '\x7f')) {
    return 'A branch name cannot contain ~ ^ : ? * [ or \\.';
  }
  if (name.includes('..') || name.includes('@{') || name === '@') return 'A branch name cannot contain ".." or "@{".';
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock') || name.includes('//')) {
    return 'A branch name cannot start or end with "/", or end with "." or ".lock".';
  }
  return null;
}

// Header actions

export interface SyncState {
  branch: string | null;
  /** Where Push sends the branch: its upstream, or `<remote>/<branch>` for a first push. */
  pushTarget: string | null;
  ahead: number;
  behind: number;
  /** Why each action cannot run now; `null` when it can. */
  fetchBlocked: string | null;
  pullBlocked: string | null;
  pushBlocked: string | null;
}

/** What Fetch, Pull and Push would do in this repository, mirroring the backend's rules. */
export function syncState(detail: RepoDetail): SyncState {
  const { head, upstream, remotes } = detail.status;
  const branch = head.kind === 'branch' ? head.name : null;
  const remote = remotes.length === 1 ? remotes[0]! : remotes.includes('origin') ? 'origin' : null;
  const pushTarget = branch ? (upstream ? upstream.name : remote ? `${remote}/${branch}` : null) : null;
  const ahead = upstream?.ahead ?? 0;
  const behind = upstream?.behind ?? 0;
  const noRemote = remotes.length === 0 ? 'This repository has no remote.' : null;
  const detached = head.kind === 'detached' ? 'HEAD is detached: switch to a branch first.' : null;
  const unborn = head.kind === 'unborn' ? 'There are no commits yet.' : null;
  return {
    branch,
    pushTarget,
    ahead,
    behind,
    fetchBlocked: noRemote,
    pullBlocked:
      noRemote ?? detached ?? unborn ?? (!upstream ? `${branch} has no upstream branch to pull from.` : upstream.gone ? `${upstream.name} was deleted on the remote.` : null),
    pushBlocked:
      noRemote ??
      detached ??
      unborn ??
      (pushTarget === null ? 'Several remotes and none is named origin: set an upstream first.' : upstream && !upstream.gone && ahead === 0 ? `Nothing to push: ${branch} matches ${upstream.name}.` : null),
  };
}
