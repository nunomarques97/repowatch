// The app's connection to the backend: the scan state (snapshots by
// generation), the backend status, settings and live announcements. Every
// asynchronous result checks that the hook is still mounted, so React
// StrictMode's mount, unmount, mount never applies a result twice.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { describeError, toIpcError, type AppStatus, type RepowatchClient, type ScanSnapshot, type Settings } from '../ipc';
import { describeUpdate, scanSummary } from './announce';
import { initialScanState, isScanning, scanReducer, type ScanState } from './scan-state';

export interface Repowatch {
  client: RepowatchClient;
  snapshot: ScanSnapshot | null;
  scanState: ScanState;
  scanning: boolean;
  status: AppStatus | null;
  settings: Settings | null;
  /** The last settings save failure, for the control that caused it. */
  settingsError: string | null;
  /** Text for the polite live region. */
  announcement: string;
  rescan: () => void;
  dismissScanError: () => void;
  /** Saves settings; resolves with `null` when saved or the failure message. */
  saveSettings: (next: Settings) => Promise<string | null>;
  dismissSettingsError: () => void;
  /** Reads the settings again after a failed first read. */
  reloadSettings: () => void;
  announce: (text: string) => void;
  /** Announces the result of a user's action; scan updates do not replace it for a moment. */
  announceAction: (text: string) => void;
}

const NBSP = ' ';
/** How long an action's result stays the announcement before scan updates speak again. */
const ACTION_HOLD_MS = 1500;

const message = (reason: unknown) => describeError(toIpcError(reason).error);

export function useRepowatch(client: RepowatchClient): Repowatch {
  const [scanState, dispatch] = useReducer(scanReducer, initialScanState);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const alive = useRef(false);
  const lastAnnounced = useRef<ScanSnapshot | null>(null);
  const settingsSeq = useRef(0);
  // The settings the backend last confirmed, and how many saves are in flight:
  // a failed save reverts to the confirmed values, and `settings` events do
  // not overwrite an edit that is still being saved.
  const confirmed = useRef<Settings | null>(null);
  const savesInFlight = useRef(0);

  const announce = useCallback((text: string) => {
    // A trailing non-breaking space toggles so the same words are announced again.
    setAnnouncement((previous) => (previous === text ? text + NBSP : text));
  }, []);
  // The refresh that follows an action describes the same change; the action's own words win.
  const holdUntil = useRef(0);
  const announceAction = useCallback(
    (text: string) => {
      holdUntil.current = performance.now() + ACTION_HOLD_MS;
      announce(text);
    },
    [announce],
  );

  const requestScan = useCallback(() => {
    dispatch({ type: 'scanRequested' });
    client.scan().then(
      (snapshot) => {
        if (!alive.current) return;
        dispatch({ type: 'scanSucceeded', snapshot });
      },
      (reason) => {
        if (!alive.current) return;
        const text = message(reason);
        dispatch({ type: 'scanFailed', message: text });
        announce(`Rescan failed: ${text}`);
      },
    );
  }, [client, announce]);

  const loadSettings = useCallback(() => {
    client.getSettings().then(
      (value) => {
        if (!alive.current) return;
        confirmed.current ??= value;
        setSettings((current) => current ?? value);
        setSettingsError(null);
      },
      (reason) => alive.current && setSettingsError(`Settings could not be read: ${message(reason)}`),
    );
  }, [client]);

  useEffect(() => {
    alive.current = true;
    const stops = [
      client.onSnapshot((snapshot) => alive.current && dispatch({ type: 'snapshot', snapshot })),
      client.onStatus((next) => {
        if (!alive.current) return;
        setStatus(next);
        dispatch({ type: 'status', status: next });
      }),
      client.onSettings((next) => {
        if (!alive.current) return;
        confirmed.current = next;
        if (savesInFlight.current === 0) setSettings(next);
      }),
    ];

    loadSettings();
    Promise.all([client.getStatus(), client.getSnapshot()]).then(
      ([appStatus, snapshot]) => {
        if (!alive.current) return;
        setStatus((current) => current ?? appStatus);
        dispatch({ type: 'status', status: appStatus });
        dispatch({ type: 'loaded', snapshot });
        // The backend scans at start; the mock and a restarted window may not have.
        if (!snapshot && !appStatus.scanning) requestScan();
      },
      (reason) => alive.current && dispatch({ type: 'loadFailed', message: message(reason) }),
    );

    return () => {
      alive.current = false;
      for (const stop of stops) stop();
    };
  }, [client, requestScan, loadSettings]);

  // Announce what changed, once per accepted snapshot.
  const { snapshot } = scanState;
  useEffect(() => {
    if (!snapshot || snapshot === lastAnnounced.current) return;
    const previous = lastAnnounced.current;
    lastAnnounced.current = snapshot;
    const text = previous ? describeUpdate(previous, snapshot) : scanSummary(snapshot);
    if (text && performance.now() >= holdUntil.current) announce(text);
  }, [snapshot, announce]);

  const saveSettings = useCallback(
    async (next: Settings) => {
      const seq = ++settingsSeq.current;
      savesInFlight.current++;
      setSettings(next);
      setSettingsError(null);
      try {
        const saved = await client.updateSettings(next);
        confirmed.current = saved;
        if (alive.current && seq === settingsSeq.current) setSettings(saved);
        return null;
      } catch (reason) {
        const text = `Settings were not saved: ${message(reason)}`;
        if (alive.current && seq === settingsSeq.current) {
          // Show the last confirmed values and say why; the settings screen
          // keeps the edit itself so it can be saved again.
          setSettings(confirmed.current);
          setSettingsError(text);
          announce(text);
        }
        return text;
      } finally {
        savesInFlight.current--;
      }
    },
    [client, announce],
  );

  return {
    client,
    snapshot,
    scanState,
    scanning: isScanning(scanState),
    status,
    settings,
    settingsError,
    announcement,
    rescan: requestScan,
    dismissScanError: useCallback(() => dispatch({ type: 'dismissError' }), []),
    saveSettings,
    dismissSettingsError: useCallback(() => setSettingsError(null), []),
    reloadSettings: loadSettings,
    announce,
    announceAction,
  };
}
