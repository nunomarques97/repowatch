// The ledger: one list of repositories grouped by attention, a state rail per
// row and aligned count columns (DESIGN.md "Ledger row", "Group header").
// Rows are one roving tab stop; focus stays on the selected repository when
// a refresh re-renders or regroups the list.

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import type { RepoSummary } from '../../ipc';
import {
  COUNT_COLUMNS,
  branchLabel,
  countsOf,
  flatPaths,
  isWorktree,
  primaryReason,
  reasonIcon,
  reasonText,
  relativeTime,
  rowLabel,
  type Group,
} from './model';

interface LedgerProps {
  groups: Group[];
  activePath: string | null;
  onSelect: (path: string) => void;
  /** Enter or double click on a row. */
  onOpen?: (path: string) => void;
  scanning: boolean;
  nowMs: number;
  /** Shown above the groups (discovery problems). */
  notice?: ReactNode;
  /** Shown instead of rows when nothing matches. */
  empty?: ReactNode;
}

// Set once the first repository rows are on screen: a local performance mark
// read by the cold start measurement (scripts/bench.mjs --app). It never
// leaves the page.
const DASHBOARD_PAINTED_MARK = 'repowatch:dashboard-painted';
let dashboardPainted = false;

const rowId = (path: string) => `repo-${encodeURIComponent(path).replace(/[^A-Za-z0-9_-]/g, '_')}`;

export function Ledger({ groups, activePath, onSelect, onOpen, scanning, nowMs, notice, empty }: LedgerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Whether a row had focus; kept when the focused row is removed by a re-render.
  const rowFocused = useRef(false);
  const paths = flatPaths(groups);

  useEffect(() => {
    if (dashboardPainted || groups.length === 0) return;
    dashboardPainted = true;
    // The frame after the commit has been painted.
    requestAnimationFrame(() => setTimeout(() => performance.mark(DASHBOARD_PAINTED_MARK), 0));
  }, [groups.length]);

  // After every render: if a row had focus and the re-render removed it,
  // focus the selected row again. Never takes focus from anything else.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !rowFocused.current || !activePath) return;
    const active = document.activeElement;
    if (active && active !== document.body && list.contains(active)) {
      if ((active as HTMLElement).dataset.path === activePath) return;
    } else if (active && active !== document.body) {
      return;
    }
    const row = list.querySelector<HTMLElement>(`#${rowId(activePath)}`);
    row?.focus({ preventScroll: false });
  });

  const focusPath = (path: string | undefined) => {
    if (!path) return;
    onSelect(path);
    // Focus after React has rendered the new tab stop.
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`#${rowId(path)}`)?.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = activePath ? paths.indexOf(activePath) : -1;
    const move = (to: number) => {
      event.preventDefault();
      focusPath(paths[Math.max(0, Math.min(paths.length - 1, to))]);
    };
    switch (event.key) {
      case 'ArrowDown':
      case 'j':
        return move(index + 1);
      case 'ArrowUp':
      case 'k':
        return move(index - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(paths.length - 1);
      case 'PageDown':
        return move(index + 10);
      case 'PageUp':
        return move(index - 10);
      case 'Enter':
        if (activePath && onOpen) {
          event.preventDefault();
          onOpen(activePath);
        }
        return;
    }
  };

  return (
    <section className="ledger" aria-label="Repositories">
      <div className="ledger-head" aria-hidden="true">
        <span>Repository</span>
        <span>State</span>
        {COUNT_COLUMNS.map((col) => (
          <span key={col.key} className="g" title={col.title}>
            {col.icon ? <Icon name={col.icon} /> : col.head}
          </span>
        ))}
        <span className="h-when">Last commit</span>
      </div>
      {scanning && groups.length > 0 && (
        <div className="progress" role="presentation">
          <span />
        </div>
      )}
      {notice}
      {groups.length === 0 ? (
        empty
      ) : (
        <div
          ref={listRef}
          className="rows"
          role="listbox"
          aria-label="Repositories"
          aria-busy={scanning}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            if ((event.target as HTMLElement).getAttribute('role') === 'option') rowFocused.current = true;
          }}
          onBlur={(event) => {
            const target = event.target;
            const next = event.relatedTarget as Node | null;
            if (next && listRef.current?.contains(next)) return;
            if (next) {
              rowFocused.current = false;
              return;
            }
            // Focus went nowhere: either the user clicked outside (keep it
            // there) or a re-render removed the row (focus it again).
            setTimeout(() => {
              if (target.isConnected) rowFocused.current = false;
            }, 0);
          }}
        >
          {groups.map((group) => (
            <GroupRows key={group.level ?? 'all'} group={group}>
              {group.repos.map((repo) => (
                <Row
                  key={repo.path}
                  repo={repo}
                  selected={repo.path === activePath}
                  nowMs={nowMs}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ))}
            </GroupRows>
          ))}
        </div>
      )}
    </section>
  );
}

function GroupRows({ group, children }: { group: Group; children: ReactNode }) {
  if (!group.level) {
    return <>{children}</>;
  }
  const id = `group-${group.level}`;
  return (
    <div role="group" aria-labelledby={id} className="group">
      <div className="group-head" id={id}>
        <span className="dot" style={{ '--dot': `var(--${group.level})` } as CSSProperties} />
        {group.label}
        <span className="n">{group.repos.length}</span>
      </div>
      {children}
    </div>
  );
}

interface RowProps {
  repo: RepoSummary;
  selected: boolean;
  nowMs: number;
  onSelect: (path: string) => void;
  onOpen?: (path: string) => void;
}

function Row({ repo, selected, nowMs, onSelect, onOpen }: RowProps) {
  const level = repo.attention.level;
  const { reason, more } = primaryReason(repo);
  const counts = countsOf(repo);
  const branch = branchLabel(repo);
  return (
    <div
      id={rowId(repo.path)}
      role="option"
      aria-selected={selected}
      aria-label={rowLabel(repo)}
      tabIndex={selected ? 0 : -1}
      data-path={repo.path}
      data-level={level}
      className="row"
      onClick={() => onSelect(repo.path)}
      onDoubleClick={() => onOpen?.(repo.path)}
    >
      <span className="who">
        <span className="name">{repo.name}</span>
        {isWorktree(repo) && <span className="wt">worktree</span>}
        {branch && <span className="branch mono">{branch}</span>}
      </span>
      <span className={`state t-${level}`} title={reason ? reasonText(reason) : 'Clean'}>
        <Icon name={reason ? reasonIcon(reason) : 'check'} />
        <span className="tx">{reason ? reasonText(reason) : 'Clean'}</span>
        {/* The rail beside the repository view shows the count instead of the words. */}
        {reason && 'count' in reason && <span className="rn">{reason.count}</span>}
        {more > 0 && <span className="more">+{more}</span>}
      </span>
      {COUNT_COLUMNS.map((col) => {
        const n = counts[col.key];
        return (
          <span key={col.key} className={n ? 'c' : 'c z'}>
            {n ? n : '·'}
          </span>
        );
      })}
      <span className="when">{repo.lastCommit ? relativeTime(repo.lastCommit.time, nowMs) : '—'}</span>
    </div>
  );
}
