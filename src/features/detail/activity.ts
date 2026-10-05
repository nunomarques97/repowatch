// Git actions of the repository view, per repository: at most one runs in a
// repository at a time (a second click while one runs does nothing), each
// shows its pending words, then what happened or git's error. The state is
// kept per repository above the view, so leaving a repository while its push
// runs never lets that result change the repository now shown, and coming
// back shows it. After every action, success or failure, the repository's
// `version` increases so the view reads it again.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { describeError, toIpcError, type RepowatchClient } from '../../ipc';
import { actionWords, type DetailAction } from './model';

export interface Pending {
  seq: number;
  action: DetailAction;
  text: string;
}

export interface Outcome {
  seq: number;
  action: DetailAction;
  ok: boolean;
  text: string;
  /** Git's or the backend's message, verbatim. */
  error: string | null;
}

export interface RepoActivity {
  pending: Pending | null;
  outcome: Outcome | null;
  /** Increases after every finished action. */
  version: number;
}

export type ActivityState = Readonly<Record<string, RepoActivity>>;

export type ActivityEvent =
  | { type: 'start'; repo: string; seq: number; action: DetailAction }
  | { type: 'finish'; repo: string; seq: number; error: string | null }
  | { type: 'dismiss'; repo: string; seq: number };

export const IDLE: RepoActivity = { pending: null, outcome: null, version: 0 };

export function activityReducer(state: ActivityState, event: ActivityEvent): ActivityState {
  const current = state[event.repo] ?? IDLE;
  switch (event.type) {
    case 'start':
      // One action at a time per repository.
      if (current.pending) return state;
      return {
        ...state,
        [event.repo]: { ...current, pending: { seq: event.seq, action: event.action, text: actionWords(event.action).pending } },
      };
    case 'finish': {
      // Only the running action's result counts.
      if (current.pending?.seq !== event.seq) return state;
      const { action } = current.pending;
      const words = actionWords(action);
      const outcome: Outcome = {
        seq: event.seq,
        action,
        ok: event.error === null,
        text: event.error === null ? words.done : words.failed,
        error: event.error,
      };
      return { ...state, [event.repo]: { pending: null, outcome, version: current.version + 1 } };
    }
    case 'dismiss':
      if (current.outcome?.seq !== event.seq) return state;
      return { ...state, [event.repo]: { ...current, outcome: null } };
  }
}

/** The client call of an action. */
export function callAction(client: RepowatchClient, repo: string, action: DetailAction): Promise<void> {
  switch (action.kind) {
    case 'stageFile':
      return client.stageFile(repo, action.path);
    case 'unstageFile':
      return client.unstageFile(repo, action.path);
    case 'stageHunk':
      return client.stageHunk(repo, action.path, action.hunkId);
    case 'unstageHunk':
      return client.unstageHunk(repo, action.path, action.hunkId);
    case 'commit':
      return client.commit(repo, action.message);
    case 'fetch':
      return client.fetch(repo);
    case 'pull':
      return client.pull(repo);
    case 'push':
      return client.push(repo);
    case 'createBranch':
      return client.createBranch(repo, action.name);
    case 'switchBranch':
      return client.switchBranch(repo, action.name);
    case 'deleteBranch':
      return client.deleteBranch(repo, action.name);
    case 'applyStash':
      return client.applyStash(repo, action.index, action.oid);
    case 'dropStash':
      return client.dropStash(repo, action.index, action.oid);
    case 'recoverCommit':
      return client.recoverCommit(repo, action.oid, action.branch);
    case 'open':
      return client.openRepo(repo, action.target);
  }
}

export interface RepoActions {
  activity: (repo: string) => RepoActivity;
  /** Starts `action` in `repo`; `false` (and nothing runs) while another action runs there. */
  run: (repo: string, action: DetailAction) => boolean;
  dismiss: (repo: string, seq: number) => void;
}

/**
 * The per-repository action state. `onFinish` runs for every finished action
 * with its repository, so the caller can announce only the ones of the
 * repository on screen.
 */
export function useRepoActions(client: RepowatchClient, onFinish: (repo: string, outcome: Outcome) => void): RepoActions {
  const [state, dispatch] = useReducer(activityReducer, {});
  // Checked synchronously: a double click reaches here twice before React renders.
  const running = useRef(new Map<string, number>());
  const seq = useRef(0);
  const alive = useRef(false);
  const finish = useRef(onFinish);
  useEffect(() => {
    finish.current = onFinish;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    (repo: string, action: DetailAction) => {
      if (running.current.has(repo)) return false;
      const id = ++seq.current;
      running.current.set(repo, id);
      dispatch({ type: 'start', repo, seq: id, action });
      const done = (error: string | null) => {
        running.current.delete(repo);
        if (!alive.current) return;
        dispatch({ type: 'finish', repo, seq: id, error });
        const words = actionWords(action);
        finish.current(repo, { seq: id, action, ok: error === null, text: error === null ? words.done : words.failed, error });
      };
      let started: Promise<void>;
      try {
        started = callAction(client, repo, action);
      } catch (reason) {
        started = Promise.reject(reason);
      }
      started.then(
        () => done(null),
        (reason) => done(describeError(toIpcError(reason).error)),
      );
      return true;
    },
    [client],
  );

  const activity = useCallback((repo: string) => state[repo] ?? IDLE, [state]);
  const dismiss = useCallback((repo: string, id: number) => dispatch({ type: 'dismiss', repo, seq: id }), []);
  return { activity, run, dismiss };
}
