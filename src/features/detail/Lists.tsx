// The Branches, Stashes and Lost commits tabs of the repository view. Every
// write action goes through `request`, which asks for confirmation first
// when the action needs it (delete branch, apply or drop a stash, recover).

import { useState } from 'react';
import { Icon } from '../../components/Icon';
import type { LostCommits, RepoDetail, RepoSummary } from '../../ipc';
import { relativeTime } from '../dashboard/model';
import { branchNameProblem, shortOid, type DetailAction } from './model';
import type { Outcome } from './activity';
import type { Loaded } from './useLoad';

interface ListProps {
  detail: RepoDetail;
  busy: boolean;
  /** Which action of this repository runs now, if any. */
  pending: DetailAction | null;
  request: (action: DetailAction) => void;
  nowMs: number;
}

const runs = (pending: DetailAction | null, kind: DetailAction['kind'], match: (a: DetailAction) => boolean) =>
  pending?.kind === kind && match(pending);

export function Branches({ detail, busy, pending, request, nowMs, repos, onShowRepo, outcome }: ListProps & {
  repos: readonly RepoSummary[];
  onShowRepo: (path: string) => void;
  /** The repository's last action result: a created branch clears the name field. */
  outcome: Outcome | null;
}) {
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [seen, setSeen] = useState(outcome?.seq ?? 0);
  if (outcome && outcome.seq !== seen) {
    setSeen(outcome.seq);
    if (outcome.ok && outcome.action.kind === 'createBranch' && outcome.action.name === name.trim()) setName('');
  }
  const { branches, defaultBranch } = detail.branches;
  const main = defaultBranch?.name ?? null;
  const create = () => {
    const trimmed = name.trim();
    const why = branchNameProblem(trimmed) ?? (branches.some((b) => b.name === trimmed) ? `A branch named ${trimmed} already exists.` : null);
    setProblem(why);
    if (why || busy) return;
    request({ kind: 'createBranch', name: trimmed });
  };
  const unborn = detail.status.head.kind === 'unborn';

  return (
    <div className="tab-body">
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <label htmlFor="new-branch">New branch at the current commit</label>
        <div className="inline-row">
          <input
            id="new-branch"
            className="input mono"
            value={name}
            placeholder="feature/name"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'new-branch-problem' : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
            disabled={unborn}
          />
          <button className="btn" type="submit" aria-disabled={busy || unborn}>
            <Icon name="plus" />
            Create branch
          </button>
        </div>
        {problem && (
          <p id="new-branch-problem" className="t-risk small">
            {problem}
          </p>
        )}
        {unborn && <p className="quiet small">Make the first commit before creating branches.</p>}
      </form>

      <h3 className="section">
        Local branches <span className="n">{branches.length}</span>
      </h3>
      {branches.length === 0 ? (
        <p className="quiet">No branches yet.</p>
      ) : (
        <ul className="facts items" aria-label="Local branches">
          {branches.map((b) => {
            const unmerged = (b.merge?.ahead ?? 0) > 0;
            const deletable = !b.isHead && !b.isDefault && b.merge !== null && !unmerged;
            const switching = runs(pending, 'switchBranch', (a) => a.kind === 'switchBranch' && a.name === b.name);
            const deleting = runs(pending, 'deleteBranch', (a) => a.kind === 'deleteBranch' && a.name === b.name);
            return (
              <li key={b.name} aria-current={b.isHead ? 'true' : undefined}>
                <Icon name="branch" className={unmerged ? 't-branch' : undefined} />
                <span className="item-main">
                  <span className="mono name-line">
                    <span className="ellipsis">{b.name}</span>
                    {b.isHead && <span className="tag">current</span>}
                    {b.isDefault && <span className="tag">default</span>}
                  </span>
                  <span className="meta-line">
                    {b.merge === null ? (
                      <span>{b.isDefault ? 'Default branch' : 'No default branch to compare with'}</span>
                    ) : unmerged ? (
                      <span className="t-branch">
                        {b.merge.ahead} {b.merge.ahead === 1 ? 'commit' : 'commits'} not in {main}
                      </span>
                    ) : (
                      <span>Merged into {main}</span>
                    )}
                    <span className="mono">{b.upstream ? (b.upstreamGone ? `${b.upstream} (deleted)` : b.upstream) : 'no upstream'}</span>
                    <span>{relativeTime(b.commitTime, nowMs)}</span>
                  </span>
                </span>
                <span className="item-actions">
                  {!b.isHead && (
                    <button
                      className="btn"
                      type="button"
                      aria-disabled={busy}
                      aria-label={`Switch to ${b.name}`}
                      onClick={() => request({ kind: 'switchBranch', name: b.name })}
                    >
                      {switching ? 'Switching…' : 'Switch'}
                    </button>
                  )}
                  {deletable && (
                    <button
                      className="btn ghost"
                      type="button"
                      aria-disabled={busy}
                      aria-label={`Delete branch ${b.name}`}
                      onClick={() => request({ kind: 'deleteBranch', name: b.name })}
                    >
                      {deleting ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {main && branches.some((b) => (b.merge?.ahead ?? 0) > 0) && (
        <p className="quiet small">Only branches merged into {main} can be deleted here; nothing is ever force-deleted.</p>
      )}

      {detail.worktrees.length > 0 && (
        <>
          <h3 className="section">
            Worktrees <span className="n">{detail.worktrees.length}</span>
          </h3>
          <ul className="facts items" aria-label="Worktrees">
            {detail.worktrees.map((w) => {
              const known = repos.find((r) => r.path === w.path);
              const here = w.path === detail.path;
              return (
                <li key={w.path} aria-current={here ? 'true' : undefined}>
                  <Icon name="worktree" />
                  <span className="item-main">
                    <span className="mono name-line">
                      <span className="ellipsis" title={w.path}>
                        {w.path}
                      </span>
                    </span>
                    <span className="meta-line">
                      <span className="mono">{w.detached ? 'detached HEAD' : w.bare ? 'bare' : (w.branch ?? '—')}</span>
                      <span>{w.isMain ? 'main worktree' : 'linked worktree'}</span>
                      {w.locked && <span>locked</span>}
                      {w.prunable && <span className="t-risk">folder missing</span>}
                    </span>
                  </span>
                  <span className="item-actions">
                    {here ? (
                      <span className="quiet small">Shown</span>
                    ) : known ? (
                      <button className="btn" type="button" onClick={() => onShowRepo(w.path)} aria-label={`Show worktree ${w.path}`}>
                        Show
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function Stashes({ detail, busy, pending, request, nowMs }: ListProps) {
  const { stashes } = detail;
  if (!stashes.length) {
    return (
      <div className="tab-body">
        <div className="tab-empty">
          <Icon name="stash" />
          <p>No stashes. Work saved with git stash shows up here.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="tab-body">
      <ul className="facts items" aria-label="Stashes">
        {stashes.map((s) => {
          const ref = `stash@{${s.index}}`;
          const applying = runs(pending, 'applyStash', (a) => a.kind === 'applyStash' && a.oid === s.oid);
          const dropping = runs(pending, 'dropStash', (a) => a.kind === 'dropStash' && a.oid === s.oid);
          return (
            <li key={s.oid}>
              <Icon name="stash" className="t-branch" />
              <span className="item-main">
                <span className="name-line">
                  <span className="mono">{ref}</span>
                  <span className="ellipsis">{s.message}</span>
                </span>
                <span className="meta-line">
                  <span className="mono">{shortOid(s.oid)}</span>
                  <span>{relativeTime(s.time, nowMs)}</span>
                </span>
              </span>
              <span className="item-actions">
                <button
                  className="btn"
                  type="button"
                  aria-disabled={busy}
                  aria-label={`Apply ${ref}`}
                  onClick={() => request({ kind: 'applyStash', index: s.index, oid: s.oid })}
                >
                  {applying ? 'Applying…' : 'Apply'}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  aria-disabled={busy}
                  aria-label={`Drop ${ref}`}
                  onClick={() => request({ kind: 'dropStash', index: s.index, oid: s.oid })}
                >
                  {dropping ? 'Dropping…' : 'Drop'}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface LostProps extends ListProps {
  lost: Loaded<LostCommits>;
  /** Lost commits are read only when asked (or when they were counted before). */
  asked: boolean;
  onFind: () => void;
  windowDays: number;
}

const authorName = (author: string) => author.replace(/\s*<[^>]*>\s*$/, '') || author;

export function Lost({ busy, pending, request, nowMs, lost, asked, onFind, windowDays }: LostProps) {
  const result = lost.value;
  const days = result?.windowDays ?? windowDays;
  return (
    <div className="tab-body">
      <div className="lost-intro">
        <p>
          Commits from the last {days} {days === 1 ? 'day' : 'days'} that no branch or tag reaches any more: left behind by a deleted
          branch, a reset or a dropped stash. Recovering one creates a branch at it.
        </p>
        <button className="btn" type="button" onClick={onFind} aria-disabled={lost.loading}>
          <Icon name={lost.loading ? 'refresh' : 'lost'} className={lost.loading ? 'spin' : undefined} />
          {lost.loading ? 'Searching…' : asked ? 'Search again' : 'Find lost commits'}
        </button>
      </div>
      {lost.error && (
        <div className="inline-error" role="alert">
          <Icon name="alert" className="t-risk" />
          <span className="grow">
            Lost commits could not be read: <span className="mono">{lost.error}</span>
          </span>
          <button className="btn" type="button" onClick={lost.retry}>
            <Icon name="refresh" />
            Retry
          </button>
        </div>
      )}
      {result &&
        (result.commits.length === 0 ? (
          <div className="tab-empty">
            <Icon name="check" className="t-clean" />
            <p>No lost commits in the last {days} days.</p>
          </div>
        ) : (
          <ul className="facts items" aria-label="Lost commits">
            {result.commits.map((c) => {
              const recovering = runs(pending, 'recoverCommit', (a) => a.kind === 'recoverCommit' && a.oid === c.oid);
              return (
                <li key={c.oid}>
                  <Icon name="lost" className="t-risk" />
                  <span className="item-main">
                    <span className="name-line">
                      <span className="mono">{shortOid(c.oid)}</span>
                      <span className="ellipsis">{c.subject || '(no message)'}</span>
                    </span>
                    <span className="meta-line">
                      <span>{authorName(c.author)}</span>
                      <span>{relativeTime(c.time, nowMs)}</span>
                      <span>{c.origin === 'reflog' ? 'in the reflog' : 'dangling'}</span>
                    </span>
                  </span>
                  <span className="item-actions">
                    <button
                      className="btn"
                      type="button"
                      aria-disabled={busy}
                      aria-label={`Recover ${shortOid(c.oid)} to a branch`}
                      onClick={() => request({ kind: 'recoverCommit', oid: c.oid, branch: '' })}
                    >
                      {recovering ? 'Recovering…' : 'Recover…'}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        ))}
      {result?.truncated && <p className="quiet small">Only the newest lost commits are listed.</p>}
    </div>
  );
}
