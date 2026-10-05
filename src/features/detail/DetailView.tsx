// The repository view, a git GUI for one repository (DESIGN.md "Detail
// header", "Tabs"): Fetch, Pull and Push, open in VS Code, the terminal or
// Explorer, then Changes, Branches, Stashes and Lost commits. Push, branch
// deletion, stash apply and drop, and recovery ask first, naming their
// target. One action runs at a time per repository; its pending words, then
// its result or git's error, show under the actions, and the repository is
// read again afterwards, whether it worked or not.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon, type IconName } from '../../components/Icon';
import type { LostCommits, OpenTarget, RepoDetail, RepoSummary, RepowatchClient } from '../../ipc';
import { branchLabel, isWorktree } from '../dashboard/model';
import type { RepoActions } from './activity';
import { Changes } from './Changes';
import { Branches, Lost, Stashes } from './Lists';
import {
  branchNameProblem,
  confirmation,
  fileLists,
  recoverBranchName,
  syncState,
  type Confirmation,
  type DetailAction,
} from './model';
import { useLoad } from './useLoad';

export type DetailTab = 'changes' | 'branches' | 'stashes' | 'lost';

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'branches', label: 'Branches' },
  { id: 'stashes', label: 'Stashes' },
  { id: 'lost', label: 'Lost commits' },
];

const OPEN: { target: OpenTarget; label: string; icon: IconName }[] = [
  { target: 'vsCode', label: 'Open in VS Code', icon: 'code' },
  { target: 'terminal', label: 'Open in terminal', icon: 'terminal' },
  { target: 'fileManager', label: 'Open in Explorer', icon: 'folder' },
];

interface DetailViewProps {
  client: RepowatchClient;
  summary: RepoSummary;
  /** Every scanned repository (worktrees link to theirs). */
  repos: readonly RepoSummary[];
  /** When the last full scan finished: a rescan reads the repository again. */
  scannedAt: number;
  actions: RepoActions;
  windowDays: number;
  nowMs: number;
  /** The commit message being written in this repository. */
  message: string;
  onMessage: (message: string) => void;
  onBack: () => void;
  onShowRepo: (path: string) => void;
}

interface Pending {
  repo: string;
  action: DetailAction;
  confirm: Confirmation;
  /** The new branch of a recovery, edited in the dialog. */
  branch: string;
}

/** What the dashboard knows about the repository; a change means it should be read again. */
function signature(repo: RepoSummary): string {
  return JSON.stringify([
    repo.oid,
    repo.head,
    repo.upstream,
    repo.counts,
    repo.stashCount,
    repo.branchCount,
    repo.unmergedBranches.map((b) => [b.name, b.oid, b.merge]),
    repo.worktrees.length,
    repo.error,
  ]);
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function DetailView(props: DetailViewProps) {
  const { client, summary, actions, nowMs, windowDays } = props;
  const path = summary.path;
  const activity = actions.activity(path);
  const busy = activity.pending !== null;
  const pendingAction = activity.pending?.action ?? null;
  const [tab, setTab] = useState<DetailTab>('changes');
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [lostAsked, setLostAsked] = useState<{ repo: string; n: number } | null>(null);
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});

  const refresh = `${activity.version}|${props.scannedAt}|${signature(summary)}`;
  const detailLoad = useLoad<RepoDetail>(path, refresh, () => client.repoDetail(path));
  const detail = detailLoad.value?.path === path ? detailLoad.value : null;

  const asked = lostAsked?.repo === path;
  const readLost = tab === 'lost' && (asked || summary.lostCommits !== null);
  const lost = useLoad<LostCommits>(readLost ? path : null, `${activity.version}|${asked ? lostAsked.n : 0}`, () => client.lostCommits(path));

  const fileCount = useMemo(() => {
    if (!detail) return null;
    const lists = fileLists(detail.status.entries);
    return lists.staged.length + lists.changes.length;
  }, [detail]);
  const counts: Record<DetailTab, number | null> = {
    changes: fileCount,
    branches: detail?.branches.branches.length ?? null,
    stashes: detail?.stashes.length ?? null,
    lost: lost.value && readLost ? lost.value.commits.length : summary.lostCommits,
  };

  const request = (action: DetailAction) => {
    if (busy || confirm) return;
    const confirmText = detail
      ? confirmation(action, {
          defaultBranch: detail.branches.defaultBranch?.name ?? null,
          branches: detail.branches.branches,
          stashes: detail.stashes,
          lost: lost.value?.commits ?? [],
          windowDays: lost.value?.windowDays ?? windowDays,
        })
      : null;
    if (!confirmText) {
      actions.run(path, action);
      return;
    }
    setConfirm({
      repo: path,
      action,
      confirm: confirmText,
      branch: action.kind === 'recoverCommit' ? recoverBranchName(action.oid, detail?.branches.branches ?? []) : '',
    });
  };

  // 1-4 switch tabs when focus is not in a field and no dialog is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const index = ['1', '2', '3', '4'].indexOf(event.key);
      const next = TABS[index];
      if (!next) return;
      event.preventDefault();
      setTab(next.id);
      tabRefs.current[next.id]?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onTabKey = (event: ReactKeyboardEvent) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const to = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length]!;
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const sync = detail ? syncState(detail) : null;
  const branch = branchLabel(summary);
  const upstream = detail?.status.upstream ?? summary.upstream;
  const recoverProblem =
    confirm?.action.kind === 'recoverCommit'
      ? (branchNameProblem(confirm.branch) ??
        (detail?.branches.branches.some((b) => b.name === confirm.branch) ? `A branch named ${confirm.branch} already exists.` : null))
      : null;

  return (
    <section className="pane detail" aria-label={`Repository ${summary.name}`}>
      <div className="pane-head">
        <div className="title-row">
          <button className="btn ghost icon-only back" type="button" aria-label="Back to all repositories" title="Back (Esc)" onClick={props.onBack}>
            <Icon name="back" />
          </button>
          <h1 tabIndex={-1} id="detail-title">
            {summary.name}
          </h1>
          {isWorktree(summary) && <span className="wt">worktree</span>}
          {branch && (
            <span className="ref mono" title="Current branch">
              <Icon name={summary.head?.kind === 'detached' ? 'detached' : 'branch'} />
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
        <div className="path mono" title={path}>
          {path}
        </div>
        <div className="actions" role="group" aria-label="Repository actions">
          <SyncButton
            icon="fetch"
            label="Fetch"
            running={pendingAction?.kind === 'fetch'}
            runningLabel="Fetching…"
            blocked={!sync ? 'Reading the repository…' : sync.fetchBlocked}
            busy={busy}
            onClick={() => request({ kind: 'fetch' })}
          />
          <SyncButton
            icon="down"
            label="Pull"
            running={pendingAction?.kind === 'pull'}
            runningLabel="Pulling…"
            blocked={!sync ? 'Reading the repository…' : sync.pullBlocked}
            busy={busy}
            count={sync?.behind}
            title="Fast-forward only"
            onClick={() => sync?.branch && upstream && request({ kind: 'pull', branch: sync.branch, upstream: upstream.name })}
          />
          <SyncButton
            icon="up"
            label="Push"
            ink
            running={pendingAction?.kind === 'push'}
            runningLabel="Pushing…"
            blocked={!sync ? 'Reading the repository…' : sync.pushBlocked}
            busy={busy}
            count={sync?.ahead}
            onClick={() =>
              sync?.branch && sync.pushTarget && request({ kind: 'push', branch: sync.branch, target: sync.pushTarget, commits: sync.ahead })
            }
          />
          <span className="spacer" />
          {OPEN.map((o) => (
            <button
              key={o.target}
              className="btn ghost icon-only"
              type="button"
              aria-label={o.label}
              title={o.label}
              aria-disabled={busy}
              onClick={() => request({ kind: 'open', target: o.target })}
            >
              <Icon name={o.icon} />
            </button>
          ))}
        </div>
        <ActivityLine activity={activity} onDismiss={(seq) => actions.dismiss(path, seq)} />
      </div>

      <div className="tabs" role="tablist" aria-label="Repository" onKeyDown={onTabKey}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            id={`tab-${t.id}`}
            className="tab"
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            aria-keyshortcuts={String(i + 1)}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            <span className="n">{counts[t.id] ?? '·'}</span>
          </button>
        ))}
      </div>

      <div className="tab-panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {!detail ? (
          detailLoad.error ? (
            <div className="detail-error" role="alert">
              <Icon name="alert" className="t-risk" />
              <div>
                <p className="t-risk strong">This repository could not be read</p>
                <pre className="mono">{detailLoad.error}</pre>
                <button className="btn" type="button" onClick={detailLoad.retry}>
                  <Icon name="refresh" />
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <p className="detail-loading quiet" aria-busy="true">
              Reading the repository…
            </p>
          )
        ) : (
          <>
            {detailLoad.error && (
              <div className="inline-error" role="alert">
                <Icon name="alert" className="t-risk" />
                <span className="grow">
                  Could not read the repository again; this is the last state read. <span className="mono">{detailLoad.error}</span>
                </span>
                <button className="btn" type="button" onClick={detailLoad.retry}>
                  <Icon name="refresh" />
                  Retry
                </button>
              </div>
            )}
            {tab === 'changes' && (
              <Changes
                key={path}
                client={client}
                detail={detail}
                refresh={refresh}
                busy={busy}
                pending={pendingAction}
                request={request}
                message={props.message}
                onMessage={props.onMessage}
              />
            )}
            {tab === 'branches' && (
              <Branches
                key={path}
                detail={detail}
                busy={busy}
                pending={pendingAction}
                request={request}
                nowMs={nowMs}
                repos={props.repos}
                onShowRepo={props.onShowRepo}
                outcome={activity.outcome}
              />
            )}
            {tab === 'stashes' && <Stashes key={path} detail={detail} busy={busy} pending={pendingAction} request={request} nowMs={nowMs} />}
            {tab === 'lost' && (
              <Lost
                key={path}
                detail={detail}
                busy={busy}
                pending={pendingAction}
                request={request}
                nowMs={nowMs}
                lost={lost}
                asked={asked || summary.lostCommits !== null}
                windowDays={windowDays}
                onFind={() => {
                  if (!lost.loading) setLostAsked((a) => ({ repo: path, n: a?.repo === path ? a.n + 1 : 1 }));
                }}
              />
            )}
          </>
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.confirm.title}
          body={confirm.confirm.body}
          verb={confirm.confirm.verb}
          tone={confirm.confirm.tone}
          problem={recoverProblem}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const action: DetailAction =
              confirm.action.kind === 'recoverCommit' ? { ...confirm.action, branch: confirm.branch.trim() } : confirm.action;
            setConfirm(null);
            actions.run(confirm.repo, action);
          }}
        >
          {confirm.action.kind === 'recoverCommit' && (
            <div className="confirm-field">
              <label htmlFor="recover-branch">New branch name</label>
              <input
                id="recover-branch"
                className="input mono"
                value={confirm.branch}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={recoverProblem ? true : undefined}
                aria-describedby={recoverProblem ? 'recover-problem' : undefined}
                onChange={(event) => {
                  const branch = event.target.value;
                  setConfirm((c) => (c ? { ...c, branch } : c));
                }}
              />
              {recoverProblem && (
                <p id="recover-problem" className="t-risk small">
                  {recoverProblem}
                </p>
              )}
            </div>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

interface SyncButtonProps {
  icon: IconName;
  label: string;
  runningLabel: string;
  running: boolean;
  /** Why the action cannot run; shown as its description. */
  blocked: string | null;
  busy: boolean;
  count?: number;
  ink?: boolean;
  title?: string;
  onClick: () => void;
}

function SyncButton({ icon, label, runningLabel, running, blocked, busy, count, ink, title, onClick }: SyncButtonProps) {
  const id = `why-${label.toLowerCase()}`;
  return (
    <>
      <button
        className={ink ? 'btn ink' : 'btn'}
        type="button"
        aria-disabled={busy || blocked !== null}
        aria-describedby={blocked ? id : undefined}
        title={blocked ?? title}
        onClick={() => {
          if (!busy && !blocked) onClick();
        }}
      >
        <Icon name={running ? 'refresh' : icon} className={running ? 'spin' : undefined} />
        {running ? runningLabel : label}
        {!running && count ? <span className="count">{count}</span> : null}
      </button>
      {blocked && (
        <span id={id} className="sr-only">
          {blocked}
        </span>
      )}
    </>
  );
}

function ActivityLine({ activity, onDismiss }: { activity: ReturnType<RepoActions['activity']>; onDismiss: (seq: number) => void }) {
  if (activity.pending) {
    return (
      <div className="activity" data-state="pending">
        <Icon name="refresh" className="spin" />
        <span className="grow">{activity.pending.text}</span>
      </div>
    );
  }
  const outcome = activity.outcome;
  if (!outcome) return null;
  return (
    <div className="activity" data-state={outcome.ok ? 'ok' : 'error'}>
      <Icon name={outcome.ok ? 'check' : 'alert'} className={outcome.ok ? 't-clean' : 't-risk'} />
      <span className="grow">
        <span className={outcome.ok ? undefined : 'strong'}>{outcome.text}</span>
        {outcome.error && <span className="git-error mono">{outcome.error}</span>}
      </span>
      <button className="btn ghost icon-only" type="button" aria-label="Dismiss" onClick={() => onDismiss(outcome.seq)}>
        <Icon name="close" />
      </button>
    </div>
  );
}
