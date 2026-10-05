// The Changes tab (DESIGN.md "File row", "Diff viewer", "Commit box"): staged
// and changed files as one list with a roving tab stop, the selected file's
// diff with Stage file and Stage hunk, and the commit message. File content
// is untrusted and only ever rendered as text.

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import type { DiffLine, FileDiff, RepoDetail, RepowatchClient } from '../../ipc';
import { fileLists, nextSelection, splitPath, type DetailAction, type FileRow } from './model';
import { useLoad } from './useLoad';

interface ChangesProps {
  client: RepowatchClient;
  detail: RepoDetail;
  /** Changes whenever the repository should be read again. */
  refresh: string;
  busy: boolean;
  /** Which action of this repository runs now, if any. */
  pending: DetailAction | null;
  request: (action: DetailAction) => void;
  message: string;
  onMessage: (message: string) => void;
}

const optionId = (key: string) => `file-${encodeURIComponent(key).replace(/[^A-Za-z0-9_-]/g, '_')}`;

interface Selection {
  rows: FileRow[];
  key: string | null;
  follow: 'path' | 'position';
}

export function Changes({ client, detail, refresh, busy, pending, request, message, onMessage }: ChangesProps) {
  const lists = useMemo(() => fileLists(detail.status.entries), [detail]);
  const rows = useMemo(() => [...lists.staged, ...lists.changes], [lists]);
  const [selection, setSelection] = useState<Selection>(() => ({ rows, key: rows[0]?.key ?? null, follow: 'path' }));
  // A new file list (after an action or a change on disk): keep the file in view.
  if (selection.rows !== rows) {
    setSelection({ rows, key: nextSelection(selection.rows, rows, selection.key, selection.follow), follow: selection.follow });
  }
  const selected = rows.find((r) => r.key === selection.key) ?? null;
  const select = (key: string, follow: Selection['follow'] = 'path') => setSelection({ rows, key, follow });

  const repo = detail.path;
  const diff = useLoad<FileDiff>(selected ? `${repo}\u0000${selected.key}` : null, refresh, () =>
    client.fileDiff(repo, selected!.path, selected!.side),
  );

  const toggle = (row: FileRow) =>
    request(row.side === 'staged' ? { kind: 'unstageFile', path: row.path } : { kind: 'stageFile', path: row.path });

  return (
    <div className="work">
      <div className="side">
        <div className="scroll">
          {rows.length === 0 ? (
            <div className="tab-empty">
              <Icon name="check" className="t-clean" />
              <p>
                <span className="strong">No changes.</span> The working tree matches the last commit.
              </p>
            </div>
          ) : (
            <FileList
              lists={lists}
              rows={rows}
              selectedKey={selected?.key ?? null}
              busy={busy}
              onSelect={(key) => select(key)}
              onToggle={(row) => {
                // From the list the selection moves on to the next file; from the diff it follows the file.
                select(row.key, 'position');
                toggle(row);
              }}
            />
          )}
        </div>
        <CommitBox
          staged={lists.staged.length}
          busy={busy}
          committing={pending?.kind === 'commit'}
          message={message}
          onMessage={onMessage}
          onCommit={() => request({ kind: 'commit', message, files: new Set(lists.staged.map((r) => r.path)).size })}
          unborn={detail.status.head.kind === 'unborn'}
        />
      </div>
      <DiffView
        file={selected}
        diff={diff.value?.path === selected?.path && diff.value?.side === selected?.side ? diff.value : null}
        loading={diff.loading}
        error={diff.error}
        onRetry={diff.retry}
        busy={busy}
        onFile={() => {
          if (!selected) return;
          select(selected.key, 'path');
          toggle(selected);
        }}
        onHunk={(hunkId) => {
          if (!selected) return;
          request(
            selected.side === 'staged'
              ? { kind: 'unstageHunk', path: selected.path, hunkId }
              : { kind: 'stageHunk', path: selected.path, hunkId },
          );
        }}
      />
    </div>
  );
}

interface FileListProps {
  lists: { staged: FileRow[]; changes: FileRow[] };
  rows: FileRow[];
  selectedKey: string | null;
  busy: boolean;
  onSelect: (key: string) => void;
  onToggle: (row: FileRow) => void;
}

function FileList({ lists, rows, selectedKey, busy, onSelect, onToggle }: FileListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);

  // When the focused row was replaced (a staged file moved lists), focus the selected row.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !hadFocus.current || !selectedKey) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    list.querySelector<HTMLElement>(`#${optionId(selectedKey)}`)?.focus();
  });

  const move = (event: KeyboardEvent, to: number) => {
    event.preventDefault();
    const row = rows[Math.max(0, Math.min(rows.length - 1, to))];
    if (!row) return;
    onSelect(row.key);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`#${optionId(row.key)}`)?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = rows.findIndex((r) => r.key === selectedKey);
    const row = rows[index];
    switch (event.key) {
      case 'ArrowDown':
      case 'j':
        return move(event, index + 1);
      case 'ArrowUp':
      case 'k':
        return move(event, index - 1);
      case 'Home':
        return move(event, 0);
      case 'End':
        return move(event, rows.length - 1);
      case ' ':
        event.preventDefault();
        if (row && !busy) onToggle(row);
        return;
    }
  };

  const group = (id: string, label: string, list: FileRow[]) =>
    list.length > 0 && (
      <div role="group" aria-labelledby={id} className="file-group">
        <h3 className="section" id={id}>
          {label} <span className="n">{list.length}</span>
        </h3>
        <div className="files">
          {list.map((row) => (
            <File key={row.key} row={row} selected={row.key === selectedKey} busy={busy} onSelect={onSelect} onToggle={onToggle} />
          ))}
        </div>
      </div>
    );

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Changed files"
      className="file-list"
      onKeyDown={onKeyDown}
      onFocus={() => {
        hadFocus.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && listRef.current?.contains(next)) return;
        if (next) {
          hadFocus.current = false;
          return;
        }
        // Focus went nowhere: a click outside (keep it there) or the row was replaced (focus the selection again).
        const target = event.target;
        setTimeout(() => {
          if (target.isConnected) hadFocus.current = false;
        }, 0);
      }}
    >
      {group('files-staged', 'Staged', lists.staged)}
      {group('files-changes', 'Changes', lists.changes)}
    </div>
  );
}

interface FileProps {
  row: FileRow;
  selected: boolean;
  busy: boolean;
  onSelect: (key: string) => void;
  onToggle: (row: FileRow) => void;
}

function File({ row, selected, busy, onSelect, onToggle }: FileProps) {
  const { dir, base } = splitPath(row.path);
  const staged = row.side === 'staged';
  const verb = staged ? 'Unstage' : 'Stage';
  return (
    <div
      id={optionId(row.key)}
      role="option"
      aria-selected={selected}
      aria-label={`${row.path}, ${row.change.toLowerCase()}${staged ? ', staged' : ''}`}
      tabIndex={selected ? 0 : -1}
      className="file"
      data-key={row.key}
      onClick={() => onSelect(row.key)}
    >
      <span className={`st ${row.conflicted ? 't-risk' : 't-change'}`} title={row.change} aria-hidden="true">
        {row.letter}
      </span>
      <span className="fp" title={row.originalPath ? `${row.originalPath} → ${row.path}` : row.path}>
        <span className="dir">{dir}</span>
        <span className="base">{base}</span>
      </span>
      <button
        className="mini"
        type="button"
        tabIndex={-1}
        aria-label={`${verb} ${row.path}`}
        title={`${verb} (Space)`}
        aria-disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(row.key);
          if (!busy) onToggle(row);
        }}
      >
        <Icon name={staged ? 'minus' : 'plus'} />
      </button>
    </div>
  );
}

interface CommitBoxProps {
  staged: number;
  busy: boolean;
  committing: boolean;
  message: string;
  onMessage: (message: string) => void;
  onCommit: () => void;
  unborn: boolean;
}

function CommitBox({ staged, busy, committing, message, onMessage, onCommit, unborn }: CommitBoxProps) {
  const blocked = staged === 0 ? 'Stage a file first.' : !message.trim() ? 'Write a message.' : null;
  const commit = () => {
    if (!blocked && !busy) onCommit();
  };
  return (
    <form
      className="commit"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <label htmlFor="commit-message">Commit message</label>
      <textarea
        id="commit-message"
        className="field"
        rows={3}
        value={message}
        placeholder={unborn ? 'First commit' : 'Summary of the change'}
        spellCheck
        onChange={(event) => onMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit();
          }
        }}
        aria-describedby="commit-state"
      />
      <div className="row2">
        <span id="commit-state" className={blocked ? 'quiet' : undefined}>
          {blocked ?? `${staged} ${staged === 1 ? 'file' : 'files'} staged · Ctrl Enter`}
        </span>
        <button className="btn ink" type="submit" aria-disabled={blocked !== null || busy} aria-keyshortcuts="Control+Enter">
          <Icon name={committing ? 'refresh' : 'check'} className={committing ? 'spin' : undefined} />
          {committing ? 'Committing…' : 'Commit'}
        </button>
      </div>
    </form>
  );
}

interface DiffViewProps {
  file: FileRow | null;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  busy: boolean;
  onFile: () => void;
  onHunk: (hunkId: string) => void;
}

const SIGNS: Record<DiffLine['kind'], string> = { context: '', added: '+', removed: '−', noNewline: '' };
const LINE_CLASS: Record<DiffLine['kind'], string> = { context: 'dl', added: 'dl add', removed: 'dl del', noNewline: 'dl nonl' };

function DiffView({ file, diff, loading, error, onRetry, busy, onFile, onHunk }: DiffViewProps) {
  if (!file) {
    return (
      <section className="diff diff-empty" aria-label="Diff">
        <p className="quiet">Select a file to see its changes.</p>
      </section>
    );
  }
  const staged = file.side === 'staged';
  const lines = diff?.hunks.flatMap((h) => h.lines) ?? [];
  const added = lines.filter((l) => l.kind === 'added').length;
  const removed = lines.filter((l) => l.kind === 'removed').length;
  const hunkActions = !file.conflicted && !diff?.binary;
  return (
    <section className="diff" aria-label={`Diff of ${file.path}`} aria-busy={loading}>
      <div className="diff-head">
        <span className="diff-path mono" title={file.path}>
          {file.originalPath && <span className="quiet">{file.originalPath} → </span>}
          {file.path}
        </span>
        <span className="diff-side">{staged ? 'Staged' : file.side === 'untracked' ? 'Untracked' : file.conflicted ? 'Conflicted' : 'Not staged'}</span>
        {diff && !diff.binary && (
          <span className="delta mono" aria-label={`${added} added, ${removed} removed lines`}>
            <span className="a">+{added}</span> <span className="d">−{removed}</span>
          </span>
        )}
        <span className="spacer" />
        <button className="btn" type="button" onClick={onFile} aria-disabled={busy}>
          <Icon name={staged ? 'minus' : 'plus'} />
          {staged ? 'Unstage file' : file.conflicted ? 'Mark resolved' : 'Stage file'}
        </button>
      </div>
      <div className="diff-body" tabIndex={0} aria-label={`Lines of ${file.path}`}>
        {error ? (
          <div className="diff-note" role="alert">
            <Icon name="alert" className="t-risk" />
            <span className="grow">
              The diff could not be read. <span className="mono">{error}</span>
            </span>
            <button className="btn" type="button" onClick={onRetry}>
              <Icon name="refresh" />
              Retry
            </button>
          </div>
        ) : !diff ? (
          <p className="diff-note quiet">{loading ? 'Reading the diff…' : ''}</p>
        ) : diff.binary ? (
          <p className="diff-note quiet">Binary file: there is no text diff to show.</p>
        ) : diff.hunks.length === 0 ? (
          <p className="diff-note quiet">No line changes (an empty file, a folder or a mode change).</p>
        ) : (
          <div className="lines">
            {diff.hunks.map((hunk) => (
              <div key={hunk.id} className="hunk-block">
                <div className="hunk">
                  <span className="hunk-head">{hunk.header}</span>
                  {hunkActions && (
                    <button className="btn" type="button" onClick={() => onHunk(hunk.id)} aria-disabled={busy} aria-label={`${staged ? 'Unstage' : 'Stage'} hunk ${hunk.header}`}>
                      {staged ? 'Unstage hunk' : 'Stage hunk'}
                    </button>
                  )}
                </div>
                {hunk.lines.map((line, i) => (
                  <div key={i} className={LINE_CLASS[line.kind]}>
                    <span className="ln">{line.oldLine ?? ''}</span>
                    <span className="ln">{line.newLine ?? ''}</span>
                    <span className="sg">{SIGNS[line.kind]}</span>
                    <span className="tx">{line.kind === 'noNewline' ? 'No newline at end of file' : line.text}</span>
                  </div>
                ))}
              </div>
            ))}
            {diff.truncated && <p className="diff-note quiet">The diff is too long; only its beginning is shown.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
