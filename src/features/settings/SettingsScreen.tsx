// Settings: watched and skipped folders, appearance, background fetch, the
// lost-commit window and the window behaviour. Every change saves at once;
// a failed save keeps the edited values on screen with Retry and Discard
// (see draft.ts), so nothing has to be entered twice.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { describeError, toIpcError, type Density, type Settings, type Theme } from '../../ipc';
import type { SettingsDraft } from './draft';

interface SettingsScreenProps {
  draft: SettingsDraft;
  /** Why the settings could not be read, when they are not loaded. */
  loadError: string | null;
  onReload: () => void;
  pickFolder: () => Promise<string | null>;
  onBack: () => void;
  onShowShortcuts: () => void;
}

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'comfortable', label: 'Comfortable' },
];

const FETCH_INTERVALS = [15, 30, 60, 120, 240];
const MIN_DAYS = 1;
const MAX_DAYS = 365;

/** Folder names never searched, as in crates/core/src/discovery.rs. */
const ALWAYS_SKIPPED = ['node_modules', '.cache', 'target', 'build', 'dist', '.venv'];

const sameFolder = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

/** Ends a message with a full stop so another sentence can follow it. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const minutesText = (m: number) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : `${m} minutes`);

export function SettingsScreen({ draft, loadError, onReload, pickFolder, onBack, onShowShortcuts }: SettingsScreenProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const settings = draft.draft;
  // Retry and Discard disappear with the failure: then focus goes to the heading, not nowhere.
  const banner = useRef<HTMLDivElement>(null);
  const focusInBanner = useRef(false);
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!draft.error && (focusInBanner.current || lost)) heading.current?.focus();
    focusInBanner.current = false;
  }, [draft.error]);

  return (
    <main className="settings" aria-labelledby="settings-title">
      <div className="settings-inner">
        <div className="settings-head">
          <button className="btn ghost icon-only" type="button" aria-label="Back to repositories" onClick={onBack}>
            <Icon name="back" />
          </button>
          <h1 id="settings-title" ref={heading} tabIndex={-1}>
            Settings
          </h1>
          <span className="spacer" />
          <SaveState draft={draft} />
        </div>
        {draft.error && (
          <div
            className="banner"
            role="alert"
            ref={banner}
            onFocus={() => (focusInBanner.current = true)}
            onBlur={(e) => (focusInBanner.current = !!banner.current?.contains(e.relatedTarget as Node | null))}
          >
            <Icon name="alert" className="t-risk" />
            <span className="grow">
              {sentence(draft.error)} Your change is still shown below.
            </span>
            <button className="btn" type="button" onClick={draft.retry} aria-disabled={draft.saving}>
              <Icon name="refresh" className={draft.saving ? 'spin' : undefined} />
              {draft.saving ? 'Saving…' : 'Retry'}
            </button>
            <button className="btn ghost" type="button" onClick={draft.discard}>
              Discard change
            </button>
          </div>
        )}
        {!settings ? (
          loadError ? (
            <div className="banner" role="alert">
              <Icon name="alert" className="t-risk" />
              <span className="grow">{loadError}</span>
              <button className="btn" type="button" onClick={onReload}>
                <Icon name="refresh" />
                Retry
              </button>
            </div>
          ) : (
            <p className="quiet">Loading settings…</p>
          )
        ) : (
          <Form settings={settings} change={draft.change} pickFolder={pickFolder} onShowShortcuts={onShowShortcuts} />
        )}
      </div>
    </main>
  );
}

function SaveState({ draft }: { draft: SettingsDraft }) {
  // Visual only: failures are announced by the alert, saves need no announcement.
  if (draft.saving) return <span className="save-state">Saving…</span>;
  if (draft.error) return <span className="save-state t-risk">Not saved</span>;
  if (!draft.draft) return null;
  return (
    <span className="save-state">
      <Icon name="check" className="t-clean" />
      Changes save automatically
    </span>
  );
}

interface FormProps {
  settings: Settings;
  change: (next: Settings) => void;
  pickFolder: () => Promise<string | null>;
  onShowShortcuts: () => void;
}

function Form({ settings, change, pickFolder, onShowShortcuts }: FormProps) {
  const fetch = settings.backgroundFetch;
  const intervals = FETCH_INTERVALS.includes(fetch.intervalMinutes)
    ? FETCH_INTERVALS
    : [...FETCH_INTERVALS, fetch.intervalMinutes].sort((a, b) => a - b);

  return (
    <>
      <FolderList
        id="roots"
        title="Watched folders"
        description="Repowatch looks for git repositories and worktrees under these folders."
        paths={settings.roots}
        empty="No folders yet. Add the folder that holds your projects."
        addLabel="Add folder"
        removeLabel="Stop watching"
        pickFolder={pickFolder}
        onChange={(roots) => change({ ...settings, roots })}
      />
      <FolderList
        id="excluded"
        title="Skipped folders"
        description={
          <>
            Nothing under these folders is searched. Always skipped:{' '}
            {ALWAYS_SKIPPED.map((name, i) => (
              <span key={name}>
                {i > 0 && ', '}
                <span className="mono">{name}</span>
              </span>
            ))}{' '}
            and other dependency and build folders.
          </>
        }
        paths={settings.excluded}
        empty="No skipped folders."
        addLabel="Skip a folder"
        removeLabel="Stop skipping"
        pickFolder={pickFolder}
        onChange={(excluded) => change({ ...settings, excluded })}
      />

      <section className="settings-section" aria-labelledby="appearance">
        <h2 id="appearance" className="section">
          Appearance
        </h2>
        <div className="setting-group">
          <Setting label="Theme" labelId="theme-label" hint="System follows the light or dark mode of Windows.">
            <div className="seg" role="group" aria-labelledby="theme-label">
              {THEMES.map((t) => (
                <button key={t.id} type="button" aria-pressed={settings.theme === t.id} onClick={() => change({ ...settings, theme: t.id })}>
                  {t.label}
                </button>
              ))}
            </div>
          </Setting>
          <Setting label="Density" labelId="density-label" hint="Compact fits more repositories on one screen.">
            <div className="seg" role="group" aria-labelledby="density-label">
              {DENSITIES.map((d) => (
                <button key={d.id} type="button" aria-pressed={settings.density === d.id} onClick={() => change({ ...settings, density: d.id })}>
                  {d.label}
                </button>
              ))}
            </div>
          </Setting>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="fetching">
        <h2 id="fetching" className="section">
          Remotes
        </h2>
        <div className="setting-group">
          <Setting
            label="Background fetch"
            labelId="fetch-label"
            hint="Runs a read-only git fetch in every repository, so “to pull” counts stay current. It never pushes, pulls or changes your files."
          >
            <Switch
              labelledBy="fetch-label"
              checked={fetch.enabled}
              onChange={(enabled) => change({ ...settings, backgroundFetch: { ...fetch, enabled } })}
            />
          </Setting>
          <Setting label="Fetch every" labelId="interval-label" hint={fetch.enabled ? 'Each repository at most this often.' : 'Used when background fetch is on.'}>
            <select
              className="select"
              aria-labelledby="interval-label"
              value={fetch.intervalMinutes}
              onChange={(e) => change({ ...settings, backgroundFetch: { ...fetch, intervalMinutes: Number(e.target.value) } })}
            >
              {intervals.map((m) => (
                <option key={m} value={m}>
                  {minutesText(m)}
                </option>
              ))}
            </select>
          </Setting>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="lost">
        <h2 id="lost" className="section">
          Lost commits
        </h2>
        <div className="setting-group">
          <DaysSetting days={settings.lostCommitWindowDays} onChange={(days) => change({ ...settings, lostCommitWindowDays: days })} />
        </div>
      </section>

      <section className="settings-section" aria-labelledby="window">
        <h2 id="window" className="section">
          Window
        </h2>
        <div className="setting-group">
          <Setting
            label="Keep running in the tray"
            labelId="tray-label"
            hint="Closing the window leaves Repowatch in the notification area, watching and counting."
          >
            <Switch labelledBy="tray-label" checked={settings.closeToTray} onChange={(closeToTray) => change({ ...settings, closeToTray })} />
          </Setting>
          <Setting label="Keyboard shortcuts" labelId="keys-label" hint="Ctrl K opens the command palette from anywhere.">
            <button className="btn" type="button" onClick={onShowShortcuts} aria-describedby="keys-label">
              <Icon name="keyboard" />
              Show shortcuts
            </button>
          </Setting>
        </div>
      </section>
    </>
  );
}

function Setting({ label, labelId, hint, children }: { label: string; labelId: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <p className="strong" id={labelId}>
          {label}
        </p>
        <p className="quiet">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Switch({ labelledBy, checked, onChange }: { labelledBy: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-labelledby={labelledBy} onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-text">{checked ? 'On' : 'Off'}</span>
    </button>
  );
}

/** The window in days; saved on Enter or when the field loses focus, only when valid. */
function DaysSetting({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const [text, setText] = useState(String(days));
  // A saved, reverted or discarded change resets the field without remounting it, so focus stays put.
  const [shownDays, setShownDays] = useState(days);
  if (shownDays !== days) {
    setShownDays(days);
    setText(String(days));
  }
  const value = Number(text.trim());
  const valid = /^\d+$/.test(text.trim()) && value >= MIN_DAYS && value <= MAX_DAYS;
  const commit = () => {
    if (valid && value !== days) onChange(value);
  };
  return (
    <div className="setting">
      <div className="setting-text">
        <label className="strong" htmlFor="lost-days">
          Look back
        </label>
        <p className="quiet" id="lost-days-hint">
          Commits left behind by deleted branches or resets, found in the reflog and among dangling objects, are shown for
          this many days.
        </p>
        {!valid && (
          <p className="field-error t-risk" id="lost-days-error">
            Enter a whole number of days from {MIN_DAYS} to {MAX_DAYS}.
          </p>
        )}
      </div>
      <span className="days">
        <input
          id="lost-days"
          className="field mono"
          inputMode="numeric"
          value={text}
          aria-invalid={!valid}
          aria-describedby={valid ? 'lost-days-hint' : 'lost-days-error lost-days-hint'}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        <span className="quiet">days</span>
      </span>
    </div>
  );
}

interface FolderListProps {
  id: string;
  title: string;
  description: ReactNode;
  paths: string[];
  empty: string;
  addLabel: string;
  removeLabel: string;
  pickFolder: () => Promise<string | null>;
  onChange: (paths: string[]) => void;
}

function FolderList({ id, title, description, paths, empty, addLabel, removeLabel, pickFolder, onChange }: FolderListProps) {
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const pickingRef = useRef(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const add = async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    setNote(null);
    try {
      const folder = await pickFolder();
      if (!alive.current || !folder) return;
      if (paths.some((p) => sameFolder(p, folder))) setNote({ text: `${folder} is already in the list.`, error: false });
      else onChange([...paths, folder]);
    } catch (reason) {
      if (alive.current) setNote({ text: `The folder was not added: ${describeError(toIpcError(reason).error)}`, error: true });
    } finally {
      pickingRef.current = false;
      if (alive.current) setPicking(false);
    }
  };

  const remove = (index: number) => {
    onChange(paths.filter((_, i) => i !== index));
    setNote(null);
    // The removed row's button is gone: focus the next row's, or Add.
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button');
      (buttons?.[Math.min(index, buttons.length - 1)] ?? addRef.current)?.focus();
    });
  };

  return (
    <section className="settings-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="section">
        {title} <span className="n">{paths.length}</span>
      </h2>
      <p className="quiet section-hint">{description}</p>
      {paths.length ? (
        <ul className="facts folders" ref={listRef} aria-labelledby={`${id}-title`}>
          {paths.map((path, index) => (
            <li key={path}>
              <Icon name="folder" />
              <span className="mono grow ellipsis" title={path}>
                {path}
              </span>
              <button className="btn ghost small-btn" type="button" aria-label={`${removeLabel} ${path}`} onClick={() => remove(index)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="folders-empty quiet">{empty}</p>
      )}
      <div className="folder-actions">
        <button ref={addRef} className="btn" type="button" onClick={add} aria-disabled={picking}>
          <Icon name="plus" />
          {picking ? 'Choosing a folder…' : addLabel}
        </button>
        <span className="note quiet" role="status">
          {note && !note.error ? note.text : ''}
        </span>
        {note?.error && (
          <span className="note t-risk" role="alert">
            {note.text}
          </span>
        )}
      </div>
    </section>
  );
}
