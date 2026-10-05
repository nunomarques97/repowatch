import { describe, expect, it } from 'vitest';
import { createMockClient } from '../../ipc';
import type { Branch, RepoDetail, StatusEntry } from '../../ipc';
import {
  actionWords,
  branchNameProblem,
  confirmation,
  fileLists,
  nextSelection,
  recoverBranchName,
  splitPath,
  syncState,
  type ConfirmContext,
  type DetailAction,
} from './model';

const entry = (path: string, init: Partial<StatusEntry>): StatusEntry => ({
  kind: 'changed',
  path,
  originalPath: null,
  index: 'unmodified',
  worktree: 'unmodified',
  ...init,
});

const branch = (name: string, init: Partial<Branch> = {}): Branch => ({
  name,
  oid: 'a'.repeat(40),
  isHead: false,
  isDefault: false,
  upstream: null,
  upstreamGone: false,
  commitTime: 0,
  subject: '',
  merge: { ahead: 0, behind: 0 },
  ...init,
});

const ctx: ConfirmContext = {
  defaultBranch: 'main',
  branches: [branch('main', { isDefault: true, merge: null }), branch('old/merged', { upstream: 'origin/old/merged', oid: '1234567890'.repeat(4) })],
  stashes: [{ index: 0, oid: 'b'.repeat(40), time: 0, message: 'On main: wip buttons', parents: [] }],
  lost: [{ oid: 'c'.repeat(40), parents: [], time: 0, author: 'Dev <d@x>', subject: 'Spike: tray badge', origin: 'reflog' }],
  windowDays: 30,
};

describe('file lists', () => {
  it('splits staged and working tree sides like git status, conflicts first', () => {
    const lists = fileLists([
      entry('b.ts', { index: 'modified', worktree: 'modified' }),
      entry('new.md', { kind: 'untracked' }),
      entry('a.ts', { kind: 'renamed', originalPath: 'old.ts', index: 'renamed' }),
      entry('z.py', { kind: 'conflicted', index: 'unmerged', worktree: 'unmerged' }),
      entry('gone.txt', { worktree: 'deleted' }),
    ]);
    expect(lists.staged.map((r) => [r.letter, r.path, r.side, r.originalPath])).toEqual([
      ['R', 'a.ts', 'staged', 'old.ts'],
      ['M', 'b.ts', 'staged', null],
    ]);
    expect(lists.changes.map((r) => [r.letter, r.path, r.side, r.conflicted])).toEqual([
      ['U', 'z.py', 'unstaged', true],
      ['M', 'b.ts', 'unstaged', false],
      ['D', 'gone.txt', 'unstaged', false],
      ['?', 'new.md', 'untracked', false],
    ]);
    // A file with both sides has two rows with distinct keys.
    expect(new Set([...lists.staged, ...lists.changes].map((r) => r.key)).size).toBe(6);
  });

  it('keeps the folder separate so it can truncate before the file name', () => {
    expect(splitPath('src/ipc/client.ts')).toEqual({ dir: 'src/ipc/', base: 'client.ts' });
    expect(splitPath('README.md')).toEqual({ dir: '', base: 'README.md' });
    expect(splitPath('src/')).toEqual({ dir: '', base: 'src/' });
  });
});

describe('selection after the list changes', () => {
  const before = fileLists([
    entry('a.ts', { worktree: 'modified' }),
    entry('b.ts', { worktree: 'modified' }),
    entry('c.ts', { worktree: 'modified' }),
  ]).changes;
  const afterStagingB = (() => {
    const l = fileLists([entry('a.ts', { worktree: 'modified' }), entry('b.ts', { index: 'modified' }), entry('c.ts', { worktree: 'modified' })]);
    return [...l.staged, ...l.changes];
  })();

  it('follows a file staged from its diff to the staged side', () => {
    expect(nextSelection(before, afterStagingB, 'unstaged:b.ts', 'path')).toBe('staged:b.ts');
  });

  it('moves on to the next file of the same list when staged from the list', () => {
    expect(nextSelection(before, afterStagingB, 'unstaged:b.ts', 'position')).toBe('unstaged:c.ts');
    // The last file: the nearest one before it that is still in the list.
    expect(nextSelection(before, afterStagingB.filter((r) => r.path !== 'c.ts'), 'unstaged:c.ts', 'position')).toBe('unstaged:a.ts');
  });

  it('keeps a row that is still there and empties with the list', () => {
    expect(nextSelection(before, before, 'unstaged:c.ts')).toBe('unstaged:c.ts');
    expect(nextSelection(before, [], 'unstaged:c.ts')).toBeNull();
    expect(nextSelection([], before, null)).toBe('unstaged:a.ts');
  });
});

describe('confirmations', () => {
  const needs = (action: DetailAction) => confirmation(action, ctx);

  it('asks before push, branch deletion, stash apply and drop, and recovery, naming the target', () => {
    const push = needs({ kind: 'push', branch: 'main', target: 'origin/main', commits: 2 });
    expect(push?.title).toBe('Push main to origin/main?');
    expect(push?.body).toContain('2 commits');
    expect(push?.verb).toBe('Push');
    expect(push?.body).toMatch(/Nothing is forced/);

    const del = needs({ kind: 'deleteBranch', name: 'old/merged' });
    expect(del).toMatchObject({ title: 'Delete branch old/merged?', verb: 'Delete branch', tone: 'danger' });
    expect(del?.body).toContain('1234567');
    expect(del?.body).toContain('origin/old/merged on the remote is not touched');

    expect(needs({ kind: 'applyStash', index: 0, oid: 'b'.repeat(40) })).toMatchObject({ title: 'Apply stash@{0}?', verb: 'Apply stash' });
    const drop = needs({ kind: 'dropStash', index: 0, oid: 'b'.repeat(40) });
    expect(drop).toMatchObject({ title: 'Drop stash@{0}?', verb: 'Drop stash', tone: 'danger' });
    expect(drop?.body).toContain('“On main: wip buttons”');
    expect(drop?.body).toContain('Lost commits');

    const recover = needs({ kind: 'recoverCommit', oid: 'c'.repeat(40), branch: '' });
    expect(recover?.title).toBe('Recover ccccccc to a new branch?');
    expect(recover?.body).toContain('Spike: tray badge');
  });

  it('runs the other actions at once', () => {
    for (const action of [
      { kind: 'fetch' },
      { kind: 'pull', branch: 'main', upstream: 'origin/main' },
      { kind: 'commit', message: 'x', files: 1 },
      { kind: 'stageFile', path: 'a' },
      { kind: 'switchBranch', name: 'main' },
      { kind: 'createBranch', name: 'x' },
      { kind: 'open', target: 'vsCode' },
    ] as DetailAction[]) {
      expect(needs(action)).toBeNull();
    }
  });

  it('never offers force in any word of any action', () => {
    const all: DetailAction[] = [
      { kind: 'push', branch: 'main', target: 'origin/main', commits: 0 },
      { kind: 'deleteBranch', name: 'old/merged' },
      { kind: 'dropStash', index: 0, oid: 'b'.repeat(40) },
      { kind: 'pull', branch: 'main', upstream: 'origin/main' },
    ];
    for (const action of all) {
      const c = needs(action);
      expect(c?.verb ?? '').not.toMatch(/force/i);
      expect(actionWords(action).pending).not.toMatch(/force/i);
    }
  });
});

describe('words of actions', () => {
  it('keeps the action name through the flow', () => {
    expect(actionWords({ kind: 'push', branch: 'main', target: 'origin/main', commits: 2 })).toEqual({
      pending: 'Pushing main to origin/main…',
      done: 'Pushed 2 commits to origin/main.',
      failed: 'main was not pushed.',
    });
    expect(actionWords({ kind: 'commit', message: 'Fix the tray\n\nBody', files: 1 }).done).toBe('Committed 1 file: Fix the tray');
    expect(actionWords({ kind: 'dropStash', index: 1, oid: 'x' }).done).toBe('Dropped stash@{1}.');
  });
});

describe('branch names', () => {
  it('suggests a free name for a recovered commit', () => {
    expect(recoverBranchName('c'.repeat(40), [])).toBe('recovered/ccccccc');
    expect(recoverBranchName('c'.repeat(40), [branch('recovered/ccccccc')])).toBe('recovered/ccccccc-2');
  });

  it('rejects what git would refuse, before asking git', () => {
    for (const bad of ['', ' x', 'a b', '-x', 'a..b', 'a~1', 'x.lock', 'x/', '/x', 'a@{1}', 'a\\b', 'a:b', 'a\u0001b']) {
      expect(branchNameProblem(bad), bad).not.toBeNull();
    }
    for (const good of ['feature/x', 'fix-123', 'recovered/abc1234', 'release/2.0']) {
      expect(branchNameProblem(good), good).toBeNull();
    }
  });
});

describe('fetch, pull and push', () => {
  const detailOf = async (name: string): Promise<RepoDetail> => {
    const client = createMockClient();
    const snapshot = await client.scan();
    const repo = snapshot.repos.find((r) => r.name === name)!;
    return client.repoDetail(repo.path);
  };

  it('pushes to the upstream, or publishes to origin under the same name', async () => {
    expect(syncState(await detailOf('forja'))).toMatchObject({ branch: 'main', pushTarget: 'origin/main', ahead: 4, pushBlocked: null });
    expect(syncState(await detailOf('api'))).toMatchObject({ branch: 'feature/auth', pushTarget: 'origin/feature/auth', pushBlocked: null });
  });

  it('says why an action cannot run', async () => {
    expect(syncState(await detailOf('notes')).pushBlocked).toBe('This repository has no remote.');
    expect(syncState(await detailOf('legacy-app')).pushBlocked).toMatch(/detached/);
    expect(syncState(await detailOf('docs')).pushBlocked).toMatch(/^Nothing to push/);
    expect(syncState(await detailOf('api')).pullBlocked).toMatch(/no upstream/);
    expect(syncState(await detailOf('site'))).toMatchObject({ behind: 3, pullBlocked: null, fetchBlocked: null });
  });
});
