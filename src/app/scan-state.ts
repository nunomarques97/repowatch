// The dashboard's scan state as a pure reducer. Snapshots arrive from three
// sources in any order (the initial read, scan results, `snapshot` events);
// only a higher generation replaces the current one, so a stale result never
// overwrites a newer one. Scan request failures keep the last good list.

import type { AppStatus, ScanSnapshot } from '../ipc';

export interface ScanState {
  snapshot: ScanSnapshot | null;
  /** The initial snapshot read has finished (successfully or not). */
  loaded: boolean;
  /** The backend reports a scan in progress. */
  backendScanning: boolean;
  /** Scan requests made by this window that have not settled. */
  pending: number;
  /** Why the last scan request failed; cleared by the next request. */
  error: string | null;
}

export type ScanAction =
  | { type: 'loaded'; snapshot: ScanSnapshot | null }
  | { type: 'loadFailed'; message: string }
  | { type: 'snapshot'; snapshot: ScanSnapshot }
  | { type: 'status'; status: AppStatus }
  | { type: 'scanRequested' }
  | { type: 'scanSucceeded'; snapshot: ScanSnapshot }
  | { type: 'scanFailed'; message: string }
  | { type: 'dismissError' };

export const initialScanState: ScanState = {
  snapshot: null,
  loaded: false,
  backendScanning: false,
  pending: 0,
  error: null,
};

/** The newer of two snapshots by generation; the current one wins ties. */
export function newer(current: ScanSnapshot | null, next: ScanSnapshot | null): ScanSnapshot | null {
  if (!next) return current;
  if (!current || next.generation > current.generation) return next;
  return current;
}

export function scanReducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case 'loaded':
      return { ...state, loaded: true, snapshot: newer(state.snapshot, action.snapshot) };
    case 'loadFailed':
      return { ...state, loaded: true, error: state.snapshot ? state.error : action.message };
    case 'snapshot': {
      const snapshot = newer(state.snapshot, action.snapshot);
      return snapshot === state.snapshot ? state : { ...state, snapshot };
    }
    case 'status':
      return state.backendScanning === action.status.scanning
        ? state
        : { ...state, backendScanning: action.status.scanning };
    case 'scanRequested':
      return { ...state, pending: state.pending + 1, error: null };
    case 'scanSucceeded':
      return {
        ...state,
        loaded: true,
        pending: Math.max(0, state.pending - 1),
        snapshot: newer(state.snapshot, action.snapshot),
      };
    case 'scanFailed':
      return { ...state, pending: Math.max(0, state.pending - 1), error: action.message };
    case 'dismissError':
      return state.error === null ? state : { ...state, error: null };
  }
}

export const isScanning = (state: ScanState) => state.backendScanning || state.pending > 0;

/** What the list area shows. */
export type ListPhase = 'loading' | 'noRoots' | 'noRepos' | 'failed' | 'ready';

const sameRoots = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((root, i) => root === b[i]);

/**
 * `roots` are the configured roots when settings are known. A snapshot of
 * other roots (settings just changed) shows as loading while a scan runs.
 */
export function listPhase(state: ScanState, roots: readonly string[] | null): ListPhase {
  const { snapshot } = state;
  const scanning = isScanning(state);
  if (roots && roots.length === 0) return 'noRoots';
  if (!snapshot) {
    if (!state.loaded || scanning) return 'loading';
    return state.error ? 'failed' : 'loading';
  }
  if (roots && !sameRoots(snapshot.roots, roots) && scanning) return 'loading';
  if (snapshot.roots.length === 0 && !roots) return 'noRoots';
  return snapshot.repos.length === 0 ? 'noRepos' : 'ready';
}
