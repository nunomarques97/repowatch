// The window frame (DESIGN.md "Spacing and layout"): title bar, the current
// screen and the status bar, plus the app-wide keys, the command palette,
// the shortcuts dialog and the live region.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { APP_NAME } from '../app-info';
import { Icon } from '../components/Icon';
import { Dashboard } from '../features/dashboard/Dashboard';
import { useRepoActions, type Outcome } from '../features/detail/activity';
import { DetailView } from '../features/detail/DetailView';
import { buildGroups, flatPaths, matchesFilter, matchesSearch, relativeTime, type Filter, type Sort } from '../features/dashboard/model';
import type { CommandContext, Screen } from '../features/palette/appCommands';
import { CommandPalette } from '../features/palette/CommandPalette';
import type { Command } from '../features/palette/commands';
import { ShortcutsDialog } from '../features/palette/ShortcutsDialog';
import { useSettingsDraft } from '../features/settings/draft';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { describeError, getClient, toIpcError, type Density, type OpenTarget, type RepoSummary, type RepowatchClient, type Settings } from '../ipc';
import { listPhase } from './scan-state';
import { useTheme } from './theme';
import { useRepowatch } from './useRepowatch';

type Layer = 'palette' | 'shortcuts' | null;

/** Re-renders every 30 s so relative times stay true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

const OPEN_TARGET_NAMES: Record<OpenTarget, string> = { vsCode: 'VS Code', terminal: 'the terminal', fileManager: 'Explorer' };

export function App({ client = getClient() }: { client?: RepowatchClient }) {
  const app = useRepowatch(client);
  const { settings, snapshot, scanning } = app;
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [layer, setLayer] = useState<Layer>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('attention');
  const [sort, setSort] = useState<Sort>('attention');
  const [selected, setSelected] = useState<string | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Commit messages being written, per repository.
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  // Focus to move once the next render is on screen (after a layer has closed).
  const focusNext = useRef<(() => boolean) | null>(null);
  const nowMs = useNow();

  const { rescan, saveSettings, announce, announceAction, dismissSettingsError } = app;

  // Git actions of the repository view. Their results are announced only for
  // the repository on screen; another repository's result waits in its view.
  const shownDetail = useRef<string | null>(null);
  useEffect(() => {
    shownDetail.current = screen === 'detail' ? selected : null;
  });
  const onActionFinished = useCallback(
    (repo: string, outcome: Outcome) => {
      if (outcome.ok && outcome.action.kind === 'commit') setMessages((m) => ({ ...m, [repo]: '' }));
      if (shownDetail.current !== repo) return;
      announceAction(outcome.error ? `${outcome.text} ${outcome.error}` : outcome.text);
    },
    [announceAction],
  );
  const repoActions = useRepoActions(client, onActionFinished);
  const draft = useSettingsDraft(settings, saveSettings, dismissSettingsError);
  const { change: changeSettings } = draft;
  const current = draft.draft;

  useTheme(settings?.theme ?? 'system');
  const density: Density = settings?.density ?? 'compact';
  const phase = listPhase(app.scanState, settings?.roots ?? null);
  // The first read and scan count as scanning, before the backend says so.
  const busy = scanning || phase === 'loading';

  useEffect(() => {
    const focus = focusNext.current;
    if (focus && focus()) focusNext.current = null;
  });

  const onRescan = useCallback(() => {
    if (!scanning) rescan();
  }, [scanning, rescan]);

  const onDensity = (next: Density) => {
    if (current && current.density !== next) changeSettings({ ...current, density: next });
  };

  const adding = useRef(false);
  const onAddFolder = async () => {
    if (!current || adding.current) return;
    adding.current = true;
    setAddingFolder(true);
    setActionError(null);
    try {
      const folder = await client.pickFolder();
      if (folder && !current.roots.includes(folder)) {
        changeSettings({ ...current, roots: [...current.roots, folder] });
      }
    } catch (reason) {
      setActionError(`The folder was not added: ${describeError(toIpcError(reason).error)}`);
    } finally {
      adding.current = false;
      setAddingFolder(false);
    }
  };

  const closeSettings = useCallback(() => {
    setScreen('dashboard');
    focusNext.current = () => {
      settingsButton.current?.focus();
      return true;
    };
  }, []);

  const openSettings = useCallback(() => setScreen('settings'), []);

  const focusSearch = useCallback(() => {
    setScreen('dashboard');
    focusNext.current = () => {
      if (!searchRef.current) return false;
      searchRef.current.focus();
      searchRef.current.select();
      return true;
    };
  }, []);

  /** Shows a repository's view (git actions), its heading focused. */
  const openDetail = useCallback((path: string) => {
    setSelected(path);
    setScreen('detail');
    focusNext.current = () => {
      const title = document.getElementById('detail-title');
      title?.focus();
      return !!title;
    };
  }, []);

  /** Back from the repository view to the dashboard, focus on the repository's row. */
  const closeDetail = useCallback(() => {
    setScreen('dashboard');
    focusNext.current = () => {
      const row = document.querySelector<HTMLElement>('.rows [tabindex="0"]');
      row?.focus();
      return true;
    };
  }, []);

  /** Shows a repository on the dashboard, selected and focused, widening the filter or clearing the search if they hide it. */
  const openRepo = useCallback(
    (path: string) => {
      const repo = snapshot?.repos.find((r) => r.path === path);
      if (!repo) return;
      if (screen === 'detail') {
        // In the repository view a chosen repository opens there too.
        openDetail(path);
        return;
      }
      setScreen('dashboard');
      if (!matchesFilter(repo, filter)) setFilter('all');
      if (!matchesSearch(repo, query)) setQuery('');
      setSelected(path);
      focusNext.current = () => {
        const row = [...document.querySelectorAll<HTMLElement>('.rows [role="option"]')].find((r) => r.dataset.path === path);
        row?.focus();
        return !!row;
      };
    },
    [snapshot, filter, query, screen, openDetail],
  );

  const openIn = useCallback(
    (path: string, target: OpenTarget) => {
      const name = snapshot?.repos.find((r) => r.path === path)?.name ?? path;
      setActionError(null);
      client.openRepo(path, target).then(
        () => announce(`Opened ${name} in ${OPEN_TARGET_NAMES[target]}.`),
        (reason) => {
          const text = `${name} was not opened in ${OPEN_TARGET_NAMES[target]}: ${describeError(toIpcError(reason).error)}`;
          setActionError(text);
        },
      );
    },
    [client, snapshot, announce],
  );

  // What the palette's commands act on. The selected repository is the one
  // the dashboard shows: the chosen one, or the first visible.
  const repos = snapshot?.repos ?? [];
  const keep = screen === 'detail' ? selected : null;
  const visible = layer === 'palette' ? flatPaths(buildGroups(repos, { filter, query, sort, keep })) : [];
  const shownPath = selected && visible.includes(selected) ? selected : (visible[0] ?? null);
  const paletteContext: CommandContext = {
    repos,
    screen,
    settings: current,
    filter,
    sort,
    selected: repos.find((r) => r.path === shownPath) ?? null,
    openRepo,
    showDashboard: screen === 'detail' ? closeDetail : closeSettings,
    showSettings: openSettings,
    showShortcuts: () => setLayer('shortcuts'),
    rescan: onRescan,
    addFolder: () => void onAddFolder(),
    focusSearch,
    setFilter: (next) => {
      setScreen('dashboard');
      setFilter(next);
    },
    setSort: (next) => {
      setScreen('dashboard');
      setSort(next);
    },
    saveSettings: (next: Settings) => changeSettings(next),
    openIn,
  };

  const closePalette = useCallback((command?: Command) => {
    setLayer(null);
    // Runs after the palette has handed focus back, so the command can move it.
    command?.run();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // A confirmation is answered first; no other layer opens over it.
      if (document.querySelector('dialog.confirm[open]')) return;
      const ctrl = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (ctrl && key === 'r') {
        // Ctrl R rescans instead of reloading the window.
        event.preventDefault();
        onRescan();
        return;
      }
      if (ctrl && key === 'k') {
        event.preventDefault();
        setLayer((open) => (open === 'palette' ? null : 'palette'));
        return;
      }
      if (ctrl && key === ',') {
        event.preventDefault();
        setLayer(null);
        openSettings();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (event.key === '?') {
        event.preventDefault();
        setLayer('shortcuts');
        return;
      }
      if (layer) return;
      if (event.key === '/' && screen === 'dashboard') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === 'Escape' && screen === 'settings') {
        event.preventDefault();
        closeSettings();
      }
      if (event.key === 'Escape' && screen === 'detail') {
        event.preventDefault();
        closeDetail();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRescan, screen, layer, closeSettings, openSettings, closeDetail]);

  const focusDetail = () => document.getElementById('detail-title')?.focus();
  const renderDetail = (repo: RepoSummary) => (
    <DetailView
      client={client}
      summary={repo}
      repos={repos}
      scannedAt={snapshot?.scannedAt ?? 0}
      actions={repoActions}
      windowDays={settings?.lostCommitWindowDays ?? 30}
      nowMs={nowMs}
      message={messages[repo.path] ?? ''}
      onMessage={(text) => setMessages((m) => ({ ...m, [repo.path]: text }))}
      onBack={closeDetail}
      onShowRepo={openDetail}
    />
  );

  const scanText = busy
    ? 'Scanning…'
    : snapshot
      ? `Scanned ${relativeTime(snapshot.scannedAt / 1000, nowMs)} · ${(snapshot.durationMs / 1000).toFixed(1)} s`
      : '';
  const roots = settings?.roots ?? snapshot?.roots ?? [];
  const status = app.status;
  const bannerText = actionError ?? app.settingsError;

  return (
    <div className={`frame density-${density}`}>
      <header className="bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
          </span>
          {APP_NAME}
        </div>
        {screen === 'dashboard' && (
          <div className="search" role="search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search repositories and branches"
              placeholder="Search repositories and branches"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (query) setQuery('');
                  else document.querySelector<HTMLElement>('.rows [tabindex="0"]')?.focus();
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  document.querySelector<HTMLElement>('.rows [tabindex="0"]')?.focus();
                }
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <kbd aria-hidden="true">/</kbd>
          </div>
        )}
        <button
          className="btn ghost cmdk"
          type="button"
          onClick={() => setLayer('palette')}
          aria-keyshortcuts="Control+K"
          aria-haspopup="dialog"
          title="Command palette (Ctrl K)"
        >
          Commands
          <span className="keys" aria-hidden="true">
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </span>
        </button>
        <span className="spacer" />
        <span className="scan">{scanText}</span>
        <button
          className="btn"
          type="button"
          onClick={onRescan}
          aria-disabled={scanning}
          aria-keyshortcuts="Control+R"
          title="Rescan (Ctrl R)"
        >
          <Icon name="refresh" className={scanning ? 'spin' : undefined} />
          Rescan
        </button>
        <button
          ref={settingsButton}
          className="btn ghost icon-only"
          type="button"
          aria-label="Settings"
          aria-keyshortcuts="Control+Comma"
          aria-pressed={screen === 'settings'}
          title="Settings (Ctrl ,)"
          onClick={() => (screen === 'settings' ? closeSettings() : openSettings())}
        >
          <Icon name="settings" />
        </button>
      </header>

      {screen === 'settings' ? (
        <SettingsScreen
          draft={draft}
          loadError={settings ? null : app.settingsError}
          onReload={app.reloadSettings}
          pickFolder={() => client.pickFolder()}
          onBack={closeSettings}
          onShowShortcuts={() => setLayer('shortcuts')}
        />
      ) : (
        <div className="screen">
          {bannerText && (
            <div className="banner" role="alert">
              <Icon name="alert" className="t-risk" />
              <span className="grow">{bannerText}</span>
              {!actionError && draft.error && (
                <button className="btn" type="button" onClick={draft.retry} aria-disabled={draft.saving}>
                  <Icon name="refresh" />
                  Retry
                </button>
              )}
              <button
                className="btn ghost icon-only"
                type="button"
                aria-label="Dismiss"
                onClick={() => {
                  setActionError(null);
                  app.dismissSettingsError();
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          <Dashboard
            client={client}
            phase={phase}
            snapshot={snapshot}
            scanning={scanning}
            scanError={app.scanState.error}
            query={query}
            onClearQuery={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
            density={density}
            onDensity={onDensity}
            roots={roots}
            onRescan={onRescan}
            onAddFolder={onAddFolder}
            addingFolder={addingFolder}
            nowMs={nowMs}
            filter={filter}
            onFilter={setFilter}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={setSelected}
            onOpen={(path) => (screen === 'detail' && path === selected ? focusDetail() : openDetail(path))}
            detail={screen === 'detail' ? renderDetail : null}
            onCloseDetail={closeDetail}
          />
        </div>
      )}

      <footer className="statusbar">
        <span className="live-state">
          <span className="dot" style={{ '--dot': busy ? 'var(--sync)' : 'var(--clean)' } as CSSProperties} />
          {busy ? 'Scanning' : `Watching ${status?.watchedRepos ?? snapshot?.repos.length ?? 0} repositories`}
        </span>
        <span>
          {roots.length} {roots.length === 1 ? 'folder' : 'folders'}
        </span>
        <span>Background fetch {settings?.backgroundFetch.enabled ? 'on' : 'off'}</span>
        <span className="spacer" />
        {snapshot && <span>{snapshot.attentionCount} need attention</span>}
        <button className="statusbar-keys" type="button" onClick={() => setLayer('shortcuts')} aria-keyshortcuts="Shift+?">
          <kbd aria-hidden="true">?</kbd> Shortcuts
        </button>
      </footer>

      {layer === 'palette' && <CommandPalette context={paletteContext} onClose={closePalette} />}
      {layer === 'shortcuts' && <ShortcutsDialog onClose={() => setLayer(null)} />}

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {app.announcement}
      </div>
    </div>
  );
}
