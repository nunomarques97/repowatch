import { describe, expect, it } from 'vitest';
import type { ScanSnapshot } from '../ipc';
import { createMockClient } from '../ipc/mock';
import { describeUpdate, scanSummary } from './announce';
import { initialScanState, isScanning, listPhase, newer, scanReducer, type ScanAction, type ScanState } from './scan-state';
import { resolveTheme } from './theme';

const snap = (generation: number, extra: Partial<ScanSnapshot> = {}): ScanSnapshot => ({
  generation,
  scannedAt: 1000,
  durationMs: 10,
  roots: ['C:\\r'],
  repos: [],
  issues: [],
  attentionCount: 0,
  ...extra,
});

const run = (actions: ScanAction[], state: ScanState = initialScanState) => actions.reduce(scanReducer, state);

describe('scan state', () => {
  it('keeps the highest generation whatever the arrival order', () => {
    expect(newer(snap(2), snap(1))?.generation).toBe(2);
    expect(newer(null, snap(1))?.generation).toBe(1);
    expect(newer(snap(1), null)?.generation).toBe(1);
    const s = run([
      { type: 'loaded', snapshot: snap(3) },
      { type: 'snapshot', snapshot: snap(5) },
      // A scan request that started earlier settles with an older result.
      { type: 'scanRequested' },
      { type: 'scanSucceeded', snapshot: snap(4) },
      { type: 'snapshot', snapshot: snap(2) },
      // The initial read resolving late does not go back either.
      { type: 'loaded', snapshot: snap(1) },
    ]);
    expect(s.snapshot?.generation).toBe(5);
    expect(s.pending).toBe(0);
  });

  it('keeps the last good list after a failed rescan and clears the error on retry', () => {
    let s = run([{ type: 'loaded', snapshot: snap(1) }, { type: 'scanRequested' }]);
    expect(isScanning(s)).toBe(true);
    s = scanReducer(s, { type: 'scanFailed', message: 'disk gone' });
    expect(s.error).toBe('disk gone');
    expect(s.snapshot?.generation).toBe(1);
    expect(isScanning(s)).toBe(false);
    s = scanReducer(s, { type: 'scanRequested' });
    expect(s.error).toBeNull();
    s = scanReducer(s, { type: 'scanSucceeded', snapshot: snap(2) });
    expect(s.snapshot?.generation).toBe(2);
    expect(s.error).toBeNull();
  });

  it('counts overlapping requests and follows the backend status', () => {
    let s = run([{ type: 'scanRequested' }, { type: 'scanRequested' }, { type: 'scanSucceeded', snapshot: snap(1) }]);
    expect(isScanning(s)).toBe(true);
    s = scanReducer(s, { type: 'scanFailed', message: 'x' });
    expect(isScanning(s)).toBe(false);
    s = scanReducer(s, { type: 'status', status: { scanning: true, watchedRepos: 0, backgroundFetchRunning: false, lastBackgroundFetchAt: null } });
    expect(isScanning(s)).toBe(true);
    // A settle without a request never goes negative.
    expect(scanReducer(initialScanState, { type: 'scanFailed', message: 'x' }).pending).toBe(0);
  });

  it('derives loading, empty, failed and ready phases', () => {
    expect(listPhase(initialScanState, null)).toBe('loading');
    expect(listPhase(initialScanState, [])).toBe('noRoots');
    const loadedEmpty = run([{ type: 'loaded', snapshot: null }]);
    expect(listPhase(loadedEmpty, ['C:\\r'])).toBe('loading');
    const failed = run([{ type: 'loaded', snapshot: null }, { type: 'scanRequested' }, { type: 'scanFailed', message: 'no git' }]);
    expect(listPhase(failed, ['C:\\r'])).toBe('failed');
    const none = run([{ type: 'loaded', snapshot: snap(1) }]);
    expect(listPhase(none, ['C:\\r'])).toBe('noRepos');
    const ready = run([{ type: 'loaded', snapshot: snap(1, { repos: [{} as never] }) }]);
    expect(listPhase(ready, ['C:\\r'])).toBe('ready');
    // Roots just changed and the scan of the new roots is running.
    const switching = run([{ type: 'loaded', snapshot: snap(1) }, { type: 'scanRequested' }]);
    expect(listPhase(switching, ['C:\\other'])).toBe('loading');
    expect(listPhase(none, null)).toBe('noRepos');
    expect(listPhase(run([{ type: 'loaded', snapshot: snap(1, { roots: [] }) }]), null)).toBe('noRoots');
  });

  it('dismisses an error without touching the list', () => {
    const s = run([{ type: 'loaded', snapshot: snap(1) }, { type: 'scanRequested' }, { type: 'scanFailed', message: 'x' }, { type: 'dismissError' }]);
    expect(s.error).toBeNull();
    expect(s.snapshot?.generation).toBe(1);
  });
});

describe('announcements', () => {
  it('summarizes full scans and names changed repositories', async () => {
    const mock = createMockClient();
    const first = await mock.scan();
    expect(scanSummary(first)).toBe(`Scan finished: ${first.repos.length} repositories, ${first.attentionCount} need attention.`);
    const docs = first.repos.find((r) => r.name === 'docs')!;
    const updated = new Promise<ScanSnapshot>((resolve) => {
      const stop = mock.onSnapshot((s) => {
        stop();
        resolve(s);
      });
    });
    mock.touch(docs.path, 'notes.txt');
    const next = await updated;
    expect(describeUpdate(first, next)).toBe('docs: 1 modified.');
    expect(describeUpdate(next, next)).toBeNull();
    expect(describeUpdate(next, { ...next, scannedAt: next.scannedAt + 1 })).toMatch(/^Scan finished/);
  });
});

describe('theme', () => {
  it('follows the OS unless forced', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
