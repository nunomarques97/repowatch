import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../ipc/mock-data';
import { draftReducer, initialDraft, type DraftAction, type DraftState } from './draft';

const base = defaultSettings('default');
const dark = { ...base, theme: 'dark' as const };
const both = { ...dark, lostCommitWindowDays: 90 };

const run = (actions: DraftAction[], state: DraftState = initialDraft) => actions.reduce(draftReducer, state);

describe('settings draft', () => {
  it('shows the edit while saving and drops it once saved', () => {
    const saving = run([{ type: 'edit', settings: dark, seq: 1 }]);
    expect(saving).toMatchObject({ edit: dark, saving: true, error: null });
    expect(run([{ type: 'saved', seq: 1 }], saving)).toMatchObject({ edit: null, saving: false, error: null });
  });

  it('keeps the edit after a failed save, with the reason', () => {
    const failed = run([
      { type: 'edit', settings: dark, seq: 1 },
      { type: 'failed', seq: 1, error: 'Settings were not saved: disk full' },
    ]);
    expect(failed).toMatchObject({ edit: dark, saving: false, error: 'Settings were not saved: disk full' });
  });

  it('keeps the failure visible during a retry, then clears it when the retry saves', () => {
    const failed = run([
      { type: 'edit', settings: dark, seq: 1 },
      { type: 'failed', seq: 1, error: 'nope' },
    ]);
    const retrying = run([{ type: 'edit', settings: dark, seq: 2, retry: true }], failed);
    expect(retrying).toMatchObject({ edit: dark, saving: true, error: 'nope' });
    expect(run([{ type: 'saved', seq: 2 }], retrying)).toMatchObject({ edit: null, error: null });
    // A retry that fails again keeps the edit and shows the new reason.
    expect(run([{ type: 'failed', seq: 2, error: 'still no' }], retrying)).toMatchObject({ edit: dark, error: 'still no' });
  });

  it('a further edit after a failure builds on the kept edit and clears the old failure', () => {
    const failed = run([
      { type: 'edit', settings: dark, seq: 1 },
      { type: 'failed', seq: 1, error: 'nope' },
    ]);
    expect(run([{ type: 'edit', settings: both, seq: 2 }], failed)).toMatchObject({ edit: both, error: null, saving: true });
  });

  it('ignores a late result of an older save, success or failure', () => {
    const two = run([
      { type: 'edit', settings: dark, seq: 1 },
      { type: 'edit', settings: both, seq: 2 },
    ]);
    expect(run([{ type: 'saved', seq: 1 }], two)).toBe(two);
    expect(run([{ type: 'failed', seq: 1, error: 'old' }], two)).toBe(two);
    // The newer save failing after the older one succeeded still keeps the newer edit.
    expect(run([{ type: 'saved', seq: 1 }, { type: 'failed', seq: 2, error: 'new' }], two)).toMatchObject({ edit: both, error: 'new' });
  });

  it('discard drops the edit and any result still on its way', () => {
    const failed = run([
      { type: 'edit', settings: dark, seq: 1 },
      { type: 'failed', seq: 1, error: 'nope' },
    ]);
    const discarded = run([{ type: 'discard', seq: 2 }], failed);
    expect(discarded).toMatchObject({ edit: null, error: null, saving: false });
    expect(run([{ type: 'failed', seq: 1, error: 'late' }], discarded)).toBe(discarded);
  });
});
