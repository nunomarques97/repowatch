// The dashboard: filters, the ledger and the selected repository's pane, plus
// the loading, empty and failure states of the list (DESIGN.md "Loading",
// "Empty states").

import { useMemo, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import type { Density, DiscoveryIssue, RepoSummary, RepowatchClient, ScanSnapshot } from '../../ipc';
import type { ListPhase } from '../../app/scan-state';
import { FilterBar } from './FilterBar';
import { Ledger } from './Ledger';
import { SummaryPane } from './SummaryPane';
import { buildGroups, filterCounts, flatPaths, FILTERS, type Filter, type Sort } from './model';

interface DashboardProps {
  client: RepowatchClient;
  phase: ListPhase;
  snapshot: ScanSnapshot | null;
  scanning: boolean;
  scanError: string | null;
  query: string;
  onClearQuery: () => void;
  density: Density;
  onDensity: (density: Density) => void;
  roots: readonly string[];
  onRescan: () => void;
  onAddFolder: () => void;
  addingFolder: boolean;
  nowMs: number;
  /** The list view is owned by the app frame, so the command palette can change it. */
  filter: Filter;
  onFilter: (filter: Filter) => void;
  sort: Sort;
  onSort: (sort: Sort) => void;
  selected: string | null;
  onSelect: (path: string) => void;
  /** Enter, double click or Open: shows the repository view. */
  onOpen: (path: string) => void;
  /** The repository view of the selected repository, instead of its summary; `null` on the dashboard. */
  detail: ((repo: RepoSummary) => ReactNode) | null;
  /** Leaves the repository view (its repository is gone). */
  onCloseDetail: () => void;
}

export function Dashboard(props: DashboardProps) {
  const { client, phase, snapshot, scanning, query, density, nowMs, filter, sort, selected } = props;
  const { onFilter: setFilter, onSort: setSort, onSelect: setSelected } = props;

  const repos = useMemo(() => (phase === 'ready' && snapshot ? snapshot.repos : []), [phase, snapshot]);
  const counts = useMemo(() => filterCounts(repos), [repos]);
  // The repository open in the repository view stays listed even when the
  // filter or search would hide it (for example once it is clean).
  const keep = props.detail ? selected : null;
  const groups = useMemo(() => buildGroups(repos, { filter, query, sort, keep }), [repos, filter, query, sort, keep]);
  const paths = flatPaths(groups);
  // The selection survives refreshes; when its repository is filtered out or
  // gone, the first visible one is shown instead.
  const activePath = selected && paths.includes(selected) ? selected : (paths[0] ?? null);
  const activeRepo = repos.find((r) => r.path === activePath) ?? null;
  const detailRepo = props.detail && selected ? (repos.find((r) => r.path === selected) ?? null) : null;

  return (
    <>
      {phase === 'ready' && (
        <FilterBar
        filter={filter}
        counts={counts}
        onFilter={setFilter}
        sort={sort}
        onSort={setSort}
        density={density}
        onDensity={props.onDensity}
        />
      )}
      <main className="main" data-phase={phase}>
        {props.scanError && (
          <div className="banner" role="alert">
            <Icon name="alert" className="t-risk" />
            <span className="grow">
              <strong>Rescan failed.</strong> {sentence(props.scanError)}
              {snapshot && snapshot.repos.length > 0 && ' The list shows the last good scan.'}
            </span>
            <button className="btn" type="button" onClick={props.onRescan}>
              <Icon name="refresh" />
              Retry
            </button>
          </div>
        )}
        {phase === 'loading' && <LoadingList />}
        {phase === 'noRoots' && (
          <EmptyState
            title="Choose folders to watch"
            body="Repowatch looks for git repositories and worktrees under the folders you choose. Nothing leaves this PC."
          >
            <button className="btn ink" type="button" onClick={props.onAddFolder} aria-disabled={props.addingFolder}>
              <Icon name="plus" />
              {props.addingFolder ? 'Adding folder…' : 'Add folder'}
            </button>
          </EmptyState>
        )}
        {phase === 'noRepos' && (
          <EmptyState
            title="No git repositories under these folders"
            body={
              <>
                Searched{' '}
                {props.roots.map((root, i) => (
                  <span key={root}>
                    {i > 0 && ', '}
                    <span className="mono">{root}</span>
                  </span>
                ))}
                . Add the folder that holds your projects, or rescan after cloning one.
              </>
            }
          >
            <button className="btn ink" type="button" onClick={props.onAddFolder} aria-disabled={props.addingFolder}>
              <Icon name="plus" />
              {props.addingFolder ? 'Adding folder…' : 'Add folder'}
            </button>
            <button className="btn" type="button" onClick={props.onRescan} aria-disabled={scanning}>
              <Icon name="refresh" />
              Rescan
            </button>
          </EmptyState>
        )}
        {phase === 'failed' && (
          <EmptyState title="The first scan did not finish" body={props.scanError ?? 'The repositories could not be read.'}>
            <button className="btn ink" type="button" onClick={props.onRescan}>
              <Icon name="refresh" />
              Retry
            </button>
          </EmptyState>
        )}
        {phase === 'ready' && snapshot && (
          <div className={props.detail ? 'split with-detail' : 'split'}>
            <Ledger
              groups={groups}
              activePath={activePath}
              onSelect={setSelected}
              onOpen={props.onOpen}
              scanning={scanning}
              nowMs={nowMs}
              notice={<IssuesNotice issues={snapshot.issues} />}
              empty={
                <NoMatch
                  query={query}
                  filter={filter}
                  total={repos.length}
                  onClearQuery={props.onClearQuery}
                  onShowAll={() => setFilter('all')}
                />
              }
            />
            {props.detail ? (
              detailRepo ? (
                props.detail(detailRepo)
              ) : (
                <section className="pane pane-empty" aria-label="Repository not found">
                  <div className="empty-actions">
                    <p className="quiet">This repository is no longer in the scan.</p>
                    <button className="btn" type="button" onClick={props.onCloseDetail}>
                      <Icon name="back" />
                      All repositories
                    </button>
                  </div>
                </section>
              )
            ) : activeRepo ? (
              <SummaryPane
                key={activeRepo.path}
                repo={activeRepo}
                client={client}
                nowMs={nowMs}
                onRescan={props.onRescan}
                onOpen={() => props.onOpen(activeRepo.path)}
              />
            ) : (
              <section className="pane pane-empty" aria-label="No repository selected">
                <p className="quiet">Select a repository to see its state.</p>
              </section>
            )}
          </div>
        )}
      </main>
    </>
  );
}

/** Ends a message with a full stop so another sentence can follow it. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

function LoadingList() {
  return (
    <div className="loading" aria-busy="true" aria-label="Scanning for repositories">
      <p className="sr-only">Scanning for repositories…</p>
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden="true">
          <span style={{ width: `${120 + ((i * 37) % 90)}px` }} />
          <span style={{ width: `${70 + ((i * 53) % 60)}px` }} />
          <span className="cells" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, body, children }: { title: string; body: ReactNode; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-card">
        <span className="empty-mark" aria-hidden="true">
          <Icon name="folder" />
        </span>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="empty-actions">{children}</div>
      </div>
    </div>
  );
}

function IssuesNotice({ issues }: { issues: DiscoveryIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="issues" role="group" aria-label="Folders that could not be read">
      <Icon name="alert" className="t-risk" />
      <ul>
        {issues.map((issue) => (
          <li key={issue.path}>
            <span className="mono">{issue.path}</span> <span className="quiet">{issue.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface NoMatchProps {
  query: string;
  filter: Filter;
  total: number;
  onClearQuery: () => void;
  onShowAll: () => void;
}

function NoMatch({ query, filter, total, onClearQuery, onShowAll }: NoMatchProps) {
  const label = FILTERS.find((f) => f.id === filter)?.label ?? '';
  return (
    <div className="no-match" role="status">
      {query.trim() ? (
        <>
          <p>
            No repository matches <span className="mono">“{query.trim()}”</span>
            {filter !== 'all' && <> in {label}</>}.
          </p>
          <div className="empty-actions">
            <button className="btn" type="button" onClick={onClearQuery}>
              Clear search
            </button>
            {filter !== 'all' && (
              <button className="btn ghost" type="button" onClick={onShowAll}>
                Search all {total}
              </button>
            )}
          </div>
        </>
      ) : filter === 'attention' ? (
        <>
          <p className="t-clean strong">
            <Icon name="check" /> Nothing needs attention.
          </p>
          <p className="quiet">
            All {total} {total === 1 ? 'repository is' : 'repositories are'} committed, pushed and merged.
          </p>
          <div className="empty-actions">
            <button className="btn" type="button" onClick={onShowAll}>
              Show all
            </button>
          </div>
        </>
      ) : (
        <>
          <p>No repository is {label.toLowerCase()}.</p>
          <div className="empty-actions">
            <button className="btn" type="button" onClick={onShowAll}>
              Show all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
