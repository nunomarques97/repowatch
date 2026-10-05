// Reads that belong to one target (a repository, a file of it): a result is
// shown only while its target is still the one asked for, so a slow answer
// for a repository the user left never appears under another one. A reload
// of the same target keeps the last value on screen until it settles, and a
// failed read keeps the last value too, with the error and a retry.

import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, toIpcError } from '../../ipc';

export interface Loaded<T> {
  /** The last value read for this target; kept while it reloads. */
  value: T | null;
  /** Why the latest read failed; `null` while it runs or when it worked. */
  error: string | null;
  loading: boolean;
  retry: () => void;
}

interface Settled<T> {
  target: string | null;
  key: string | null;
  value: T | null;
  error: string | null;
}

/**
 * Reads `load()` for `target` (nothing when `null`) and again whenever
 * `refresh` changes. `load` must read `target`; only the latest request's
 * result is kept.
 */
export function useLoad<T>(target: string | null, refresh: string, load: () => Promise<T>): Loaded<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ target: null, key: null, value: null, error: null });
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  const key = target === null ? null : `${target}\u0000${refresh}\u0000${attempt}`;

  useEffect(() => {
    if (target === null || key === null) return;
    let live = true;
    latest.current().then(
      (value) => {
        if (live) setSettled({ target, key, value, error: null });
      },
      (reason) => {
        if (!live) return;
        const error = describeError(toIpcError(reason).error);
        setSettled((previous) => ({ target, key, value: previous.target === target ? previous.value : null, error }));
      },
    );
    return () => {
      live = false;
    };
  }, [target, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const same = target !== null && settled.target === target;
  const loading = target !== null && settled.key !== key;
  return {
    value: same ? settled.value : null,
    error: same && !loading ? settled.error : null,
    loading,
    retry,
  };
}
