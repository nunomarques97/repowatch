import { describe, expect, it } from 'vitest';
import { createMockClient } from '../../ipc';
import { activityReducer, callAction, IDLE, type ActivityEvent, type ActivityState } from './activity';
import type { DetailAction } from './model';

const push: DetailAction = { kind: 'push', branch: 'main', target: 'origin/main', commits: 2 };
const fetchAction: DetailAction = { kind: 'fetch' };
const run = (events: ActivityEvent[], state: ActivityState = {}) => events.reduce(activityReducer, state);

describe('per-repository action state', () => {
  it('shows the pending words, then the result, and counts a new version after success and failure', () => {
    const started = run([{ type: 'start', repo: 'A', seq: 1, action: push }]);
    expect(started.A?.pending?.text).toBe('Pushing main to origin/main…');
    const ok = run([{ type: 'finish', repo: 'A', seq: 1, error: null }], started);
    expect(ok.A).toMatchObject({ pending: null, version: 1, outcome: { ok: true, text: 'Pushed 2 commits to origin/main.', error: null } });
    const failed = run(
      [
        { type: 'start', repo: 'A', seq: 2, action: push },
        { type: 'finish', repo: 'A', seq: 2, error: '! [rejected] main -> main (fetch first)' },
      ],
      ok,
    );
    expect(failed.A).toMatchObject({
      version: 2,
      outcome: { ok: false, text: 'main was not pushed.', error: '! [rejected] main -> main (fetch first)' },
    });
  });

  it('ignores a second action while one runs in the same repository', () => {
    const state = run([
      { type: 'start', repo: 'A', seq: 1, action: push },
      { type: 'start', repo: 'A', seq: 2, action: fetchAction },
    ]);
    expect(state.A?.pending?.seq).toBe(1);
    // The ignored action's result never lands.
    expect(run([{ type: 'finish', repo: 'A', seq: 2, error: null }], state)).toBe(state);
  });

  it('keeps repositories apart: a result lands only on its own repository', () => {
    const state = run([
      { type: 'start', repo: 'A', seq: 1, action: push },
      { type: 'start', repo: 'B', seq: 2, action: fetchAction },
      { type: 'finish', repo: 'A', seq: 1, error: 'rejected' },
    ]);
    expect(state.B).toMatchObject({ pending: { seq: 2 }, outcome: null, version: 0 });
    expect(state.A).toMatchObject({ pending: null, outcome: { ok: false } });
    // A result for a repository with no running action changes nothing.
    expect(run([{ type: 'finish', repo: 'C', seq: 1, error: null }], state)).toBe(state);
  });

  it('dismisses only the outcome it was asked to', () => {
    const state = run([
      { type: 'start', repo: 'A', seq: 1, action: fetchAction },
      { type: 'finish', repo: 'A', seq: 1, error: null },
    ]);
    expect(run([{ type: 'dismiss', repo: 'A', seq: 9 }], state)).toBe(state);
    expect(run([{ type: 'dismiss', repo: 'A', seq: 1 }], state).A).toEqual({ ...IDLE, version: 1 });
  });
});

describe('client calls', () => {
  it('maps every action to its command with the repository first', async () => {
    const client = createMockClient();
    const snapshot = await client.scan();
    const repo = snapshot.repos.find((r) => r.name === 'design-system')!.path;
    const stash = (await client.repoDetail(repo)).stashes[1]!;
    await callAction(client, repo, { kind: 'createBranch', name: 'feature/new' });
    await callAction(client, repo, { kind: 'deleteBranch', name: 'old/merged' });
    await callAction(client, repo, { kind: 'dropStash', index: stash.index, oid: stash.oid });
    await callAction(client, repo, { kind: 'open', target: 'terminal' });
    expect(client.calls.slice(-4).map((c) => [c.command, ...c.args])).toEqual([
      ['createBranch', repo, 'feature/new', undefined],
      ['deleteBranch', repo, 'old/merged'],
      ['dropStash', repo, 1, stash.oid],
      ['openRepo', repo, 'terminal'],
    ]);
    // Unmerged branches are refused by the backend; the UI shows its words.
    await expect(callAction(client, repo, { kind: 'deleteBranch', name: 'feature/tokens' })).rejects.toMatchObject({
      error: { kind: 'git', error: { kind: 'branchNotMerged', branch: 'feature/tokens' } },
    });
  });
});
