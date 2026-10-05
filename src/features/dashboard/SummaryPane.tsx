// The dashboard pane: the selected repository's state in words, with every
// fact the dashboard tracks (DESIGN.md "Detail header" on the dashboard).
// Git write actions live in the repository detail view.

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { describeError, toIpcError, type AttentionReason, type RepoSummary, type RepowatchClient } from '../../ipc';
import { branchLabel, isWorktree, reasonIcon, reasonText, relativeTime } from './model';

interface SummaryPaneProps {
  repo: RepoSummary;
  client: RepowatchClient;
  nowMs: number;
  onRescan: () => void;
  /** Shows the repository view (git actions). */
  onOpen: () => void;
}

/** One line of context for each reason. */
function reasonHint(reason: AttentionReason, repo: RepoSummary): string {
  const upstream = repo.upstream?.name ?? 'the upstream';
  const main = repo.defaultBranch?.name ?? 'the default branch';
  switch (reason.kind) {
    case 'scanError':
      return 'Git could not read this repository';
    case 'conflicts':
      return 'Resolve them before committing';
    case 'detachedHead':
      return 'New commits here belong to no branch';
    case 'lostCommits':
      return 'Reachable only from the reflog or dangling';
    case 'staged':
      return 'Ready to commit';
    case 'unstaged':
      return 'Changed, not staged';
    case 'untracked':
      return 'New files git does not track yet';
    case 'ahead':
      return `Commits not on ${upstream}`;
    case 'behind':
      return `On ${upstream} as of the last fetch`;
    case 'noUpstream':
      return 'This branch is not published';
    case 'upstreamGone':
      return `${upstream} was deleted on the remote`;
    case 'noRemote':
      return 'Exists only on this PC';
    case 'unmergedBranches':
      return `Not merged into ${main}`;
    case 'stashes':
      return 'Saved work outside any branch';
  }
}

const short = (oid: string) => oid.slice(0, 7);
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function SummaryPane({ repo, client, nowMs, onRescan, onOpen }: SummaryPaneProps) {
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [lostErrors, setLostErrors] = useState<Readonly<Record<string, string>>>({});
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const path = repo.path;
  const busy = checking.has(path);
  const checkLost = () => {
    if (busy) return;
    setChecking((s) => new Set(s).add(path));
    setLostErrors((e) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== path)));
    // The count reaches the dashboard through the next snapshot; the result
    // only clears this repository's pending state, whichever one is shown.
    client.lostCommits(path).then(
      () => undefined,
      (reason) => {
        if (alive.current) setLostErrors((e) => ({ ...e, [path]: describeError(toIpcError(reason).error) }));
      },
    ).finally(() => {
      if (!alive.current) return;
      setChecking((s) => {
        const next = new Set(s);
        next.delete(path);
        return next;
      });
    });
  };

  const branch = branchLabel(repo);
  const upstream = repo.upstream;
  const reasons = repo.attention.reasons;

  return (
    <section className="pane" aria-label={`Repository ${repo.name}`}>
      <div className="pane-head">
        <div className="title-row">
          <h1>{repo.name}</h1>
          {isWorktree(repo) && <span className="wt">worktree</span>}
          {branch && (
            <span className="ref mono" title="Current branch">
              <Icon name={repo.head?.kind === 'detached' ? 'detached' : 'branch'} />
              {branch}
            </span>
          )}
          {upstream && (upstream.ahead > 0 || upstream.behind > 0) && (
            <span className="ref mono t-sync" title={`Compared with ${upstream.name}`}>
              {upstream.ahead > 0 && (
                <>
                  <Icon name="up" />
                  {upstream.ahead} to push
                </>
              )}
              {upstream.ahead > 0 && upstream.behind > 0 && ' · '}
              {upstream.behind > 0 && (
                <>
                  <Icon name="down" />
                  {upstream.behind} to pull
                </>
              )}
            </span>
          )}
        </div>
        <div className="path mono" title={repo.path}>
          {repo.path}
        </div>
        {!repo.error && (
          <div className="actions">
            <button className="btn ink" type="button" onClick={onOpen} aria-keyshortcuts="Enter" title="Open the repository (Enter)">
              <Icon name="go" />
              Open repository
            </button>
            <span className="quiet small">Changes, commit, push, branches, stashes</span>
          </div>
        )}
        {repo.error ? (
          <div className="pane-error" role="group" aria-label="Error">
            <Icon name="alert" className="t-risk" />
            <div>
              <p className="t-risk strong">Could not read this repository</p>
              <pre className="mono">{reasons[0]?.kind === 'scanError' ? reasons[0].message : describeError({ kind: 'git', error: repo.error })}</pre>
              <button className="btn" type="button" onClick={onRescan}>
                <Icon name="refresh" />
                Rescan
              </button>
            </div>
          </div>
        ) : reasons.length > 0 ? (
          <ul className="attention" aria-label="Needs attention">
            {reasons.map((reason) => (
              <li key={reason.kind}>
                <Icon name={reasonIcon(reason)} className={`t-${reason.level}`} />
                <span className={`label t-${reason.level}`}>{reasonText(reason)}</span>
                <span className="hint">{reasonHint(reason, repo)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="all-clean">
            <Icon name="check" className="t-clean" />
            <span className="t-clean strong">Clean</span>
            <span className="hint">Everything is committed and in sync{upstream ? ` with ${upstream.name}` : ''}.</span>
          </p>
        )}
      </div>

      {!repo.error && (
        <div className="pane-body">
          <h2 className="section">
            Unmerged branches <span className="n">{repo.unmergedBranches.length}</span>
          </h2>
          {repo.unmergedBranches.length ? (
            <ul className="facts">
              {repo.unmergedBranches.map((b) => (
                <li key={b.name}>
                  <Icon name="branch" className="t-branch" />
                  <span className="mono grow">{b.name}</span>
                  <span className="mono">
                    {b.merge?.ahead ?? 0} {b.merge?.ahead === 1 ? 'commit' : 'commits'}
                  </span>
                  <span className="meta">{relativeTime(b.commitTime, nowMs)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet">
              {repo.defaultBranch ? `Every branch is merged into ${repo.defaultBranch.name}.` : 'No default branch found.'}
            </p>
          )}

          {repo.worktrees.length > 0 && (
            <>
              <h2 className="section">
                Worktrees <span className="n">{repo.worktrees.length}</span>
              </h2>
              <ul className="facts">
                {repo.worktrees.map((w) => (
                  <li key={w.path} aria-current={w.path === repo.path ? 'true' : undefined}>
                    <Icon name="worktree" />
                    {/* The folder name; the full path is in the tooltip and on the row of that worktree. */}
                    <span className="mono grow ellipsis" title={w.path}>
                      {folderName(w.path)}
                    </span>
                    <span className="mono">{w.detached ? 'detached' : (w.branch ?? '—')}</span>
                    <span className="meta">{w.isMain ? 'main' : w.path === repo.path ? 'this' : 'linked'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2 className="section">Lost commits</h2>
          <div className="lost">
            <p>
              {busy
                ? 'Checking the reflog and dangling commits…'
                : repo.lostCommits === null
                  ? 'Not checked yet. Checking reads the reflog and unreachable objects.'
                  : repo.lostCommits === 0
                    ? 'None found in the configured window.'
                    : `${repo.lostCommits} lost ${repo.lostCommits === 1 ? 'commit' : 'commits'} found. Recover them from Open repository → Lost commits.`}
            </p>
            <button className="btn" type="button" onClick={checkLost} aria-disabled={busy}>
              <Icon name="lost" />
              {busy ? 'Checking…' : repo.lostCommits === null ? 'Check for lost commits' : 'Check again'}
            </button>
            {lostErrors[path] && (
              <p className="t-risk" role="alert">
                {lostErrors[path]}
              </p>
            )}
          </div>

          <h2 className="section">Last commit</h2>
          {repo.lastCommit ? (
            <p className="last">
              <span className="mono meta">{short(repo.lastCommit.oid)}</span>
              <span className="grow ellipsis">{repo.lastCommit.subject}</span>
              <span className="meta">{relativeTime(repo.lastCommit.time, nowMs)}</span>
            </p>
          ) : (
            <p className="quiet">No commits yet.</p>
          )}

          <p className="quiet small">
            {repo.stashCount} {repo.stashCount === 1 ? 'stash' : 'stashes'} · {repo.branchCount}{' '}
            {repo.branchCount === 1 ? 'local branch' : 'local branches'}
            {repo.remotes.length ? ` · remotes: ${repo.remotes.join(', ')}` : ' · no remote'}
          </p>
        </div>
      )}
    </section>
  );
}
