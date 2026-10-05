// The settings screen's edits. Every change is saved at once; until the save
// succeeds the edited values stay on screen, so a failed save can be retried
// (or discarded) without the user making the change again. Only the result
// of the latest save counts: an older one settling late never clears or
// overrides a newer edit.

import { useCallback, useReducer, useRef } from 'react';
import type { Settings } from '../../ipc';

export interface DraftState {
  /** Edited settings not yet confirmed by the backend; `null` when there are none. */
  edit: Settings | null;
  /** Sequence number of the latest save. */
  seq: number;
  saving: boolean;
  /** Why the latest save failed. */
  error: string | null;
}

export type DraftAction =
  /** `retry` keeps the failure on screen until the new attempt settles. */
  | { type: 'edit'; settings: Settings; seq: number; retry?: boolean }
  | { type: 'saved'; seq: number }
  | { type: 'failed'; seq: number; error: string }
  | { type: 'discard'; seq: number };

export const initialDraft: DraftState = { edit: null, seq: 0, saving: false, error: null };

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'edit':
      return { edit: action.settings, seq: action.seq, saving: true, error: action.retry ? state.error : null };
    case 'saved':
      return action.seq === state.seq ? { ...state, edit: null, saving: false, error: null } : state;
    case 'failed':
      return action.seq === state.seq ? { ...state, saving: false, error: action.error } : state;
    case 'discard':
      return { edit: null, seq: action.seq, saving: false, error: null };
  }
}

export interface SettingsDraft {
  /** What the settings screen shows: the edit, or the saved settings. */
  draft: Settings | null;
  saving: boolean;
  /** The failed save's message while its edit is kept. */
  error: string | null;
  /** Shows `next` and saves it. */
  change: (next: Settings) => void;
  /** Saves the kept edit again. */
  retry: () => void;
  /** Drops the kept edit and shows the saved settings. */
  discard: () => void;
}

/**
 * `save` resolves with `null` when saved or the failure message. The hook
 * lives in the app frame, so a failed edit survives leaving Settings.
 * `onDiscard` clears whatever else reports the dropped edit's failure.
 */
export function useSettingsDraft(
  saved: Settings | null,
  save: (next: Settings) => Promise<string | null>,
  onDiscard?: () => void,
): SettingsDraft {
  const [state, dispatch] = useReducer(draftReducer, initialDraft);
  const seq = useRef(0);

  const saveDraft = useCallback(
    (next: Settings, retry: boolean) => {
      const mine = ++seq.current;
      dispatch({ type: 'edit', settings: next, seq: mine, retry });
      void save(next).then((error) =>
        dispatch(error === null ? { type: 'saved', seq: mine } : { type: 'failed', seq: mine, error }),
      );
    },
    [save],
  );
  const change = useCallback((next: Settings) => saveDraft(next, false), [saveDraft]);

  const { edit, saving } = state;
  const retry = useCallback(() => {
    if (edit && !saving) saveDraft(edit, true);
  }, [edit, saving, saveDraft]);
  const discard = useCallback(() => {
    dispatch({ type: 'discard', seq: ++seq.current });
    onDiscard?.();
  }, [onDiscard]);

  return { draft: edit ?? saved, saving: state.saving, error: state.error, change, retry, discard };
}
