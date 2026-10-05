// Light and dark follow the OS (`prefers-color-scheme`) unless Settings force
// one. The effective theme is the `data-theme` attribute on <html>, which
// selects the token block in styles/tokens.css.

import { useEffect } from 'react';
import type { Theme } from '../ipc';

export type EffectiveTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveTheme(theme: Theme, systemDark: boolean): EffectiveTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

const systemDark = () => typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): EffectiveTheme {
  const effective = resolveTheme(theme, systemDark());
  root.dataset.theme = effective;
  root.dataset.themeSource = theme;
  return effective;
}

/** Applies `theme` now and again whenever the OS preference changes. */
export function useTheme(theme: Theme) {
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);
}
