// The palette's commands for the current app state. Only non-destructive
// commands exist here: navigation, scans, view options and settings that can
// be switched back. Git write actions stay in the repository view, behind
// their confirmations.

import type { Density, OpenTarget, RepoSummary, Settings, Theme } from '../../ipc';
import { FILTERS, SORTS, type Filter, type Sort } from '../dashboard/model';
import { repoCommand, type Command } from './commands';

export type Screen = 'dashboard' | 'detail' | 'settings';

export interface CommandContext {
  repos: readonly RepoSummary[];
  screen: Screen;
  settings: Settings | null;
  filter: Filter;
  sort: Sort;
  /** The repository selected on the dashboard or open in the repository view. */
  selected: RepoSummary | null;
  openRepo: (path: string) => void;
  showDashboard: () => void;
  showSettings: () => void;
  showShortcuts: () => void;
  rescan: () => void;
  addFolder: () => void;
  focusSearch: () => void;
  setFilter: (filter: Filter) => void;
  setSort: (sort: Sort) => void;
  saveSettings: (next: Settings) => void;
  openIn: (path: string, target: OpenTarget) => void;
}

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'Use the system theme' },
  { id: 'light', label: 'Use the light theme' },
  { id: 'dark', label: 'Use the dark theme' },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: 'compact', label: 'Compact rows' },
  { id: 'comfortable', label: 'Comfortable rows' },
];

const OPEN_TARGETS: { id: OpenTarget; label: string; icon: Command['icon'] }[] = [
  { id: 'vsCode', label: 'Open in VS Code', icon: 'code' },
  { id: 'terminal', label: 'Open in terminal', icon: 'terminal' },
  { id: 'fileManager', label: 'Open in Explorer', icon: 'folder' },
];

export function buildCommands(ctx: CommandContext): Command[] {
  const commands: Command[] = ctx.repos.map((repo) => repoCommand(repo, () => ctx.openRepo(repo.path)));

  if (ctx.screen !== 'dashboard') {
    commands.push({ id: 'go:dashboard', group: 'screens', label: 'Repositories', detail: 'Dashboard', icon: 'go', shortcut: 'Esc', run: ctx.showDashboard });
  }
  if (ctx.screen !== 'settings') {
    commands.push({ id: 'go:settings', group: 'screens', label: 'Settings', keywords: 'preferences options folders', icon: 'settings', shortcut: 'Ctrl ,', run: ctx.showSettings });
  }
  commands.push({ id: 'go:shortcuts', group: 'screens', label: 'Keyboard shortcuts', keywords: 'keys help', icon: 'keyboard', shortcut: '?', run: ctx.showShortcuts });

  commands.push(
    { id: 'act:rescan', group: 'actions', label: 'Rescan all folders', keywords: 'refresh scan reload', icon: 'refresh', shortcut: 'Ctrl R', run: ctx.rescan },
    { id: 'act:add-folder', group: 'actions', label: 'Add a folder to watch…', keywords: 'root folder', icon: 'plus', run: ctx.addFolder },
    { id: 'act:search', group: 'actions', label: 'Search the list', keywords: 'find filter', icon: 'search', shortcut: '/', run: ctx.focusSearch },
  );

  const selected = ctx.selected;
  if (selected && !selected.error) {
    for (const target of OPEN_TARGETS) {
      commands.push({
        id: `open:${target.id}`,
        group: 'actions',
        label: target.label,
        detail: selected.name,
        keywords: selected.path,
        icon: target.icon,
        run: () => ctx.openIn(selected.path, target.id),
      });
    }
  }

  for (const filter of FILTERS) {
    if (filter.id === ctx.filter) continue;
    commands.push({
      id: `filter:${filter.id}`,
      group: 'actions',
      label: `Show ${filter.id === 'all' ? 'all repositories' : filter.label.toLowerCase()}`,
      keywords: 'filter list',
      icon: 'filter',
      run: () => ctx.setFilter(filter.id),
    });
  }
  for (const sort of SORTS) {
    if (sort.id === ctx.sort) continue;
    commands.push({ id: `sort:${sort.id}`, group: 'actions', label: `Sort by ${sort.label.toLowerCase()}`, keywords: 'order list', icon: 'sort', run: () => ctx.setSort(sort.id) });
  }

  const settings = ctx.settings;
  if (settings) {
    for (const theme of THEMES) {
      if (theme.id === settings.theme) continue;
      commands.push({ id: `theme:${theme.id}`, group: 'actions', label: theme.label, keywords: 'appearance dark light mode', icon: 'theme', run: () => ctx.saveSettings({ ...settings, theme: theme.id }) });
    }
    for (const density of DENSITIES) {
      if (density.id === settings.density) continue;
      commands.push({ id: `density:${density.id}`, group: 'actions', label: density.label, keywords: 'density spacing appearance', icon: 'rows', run: () => ctx.saveSettings({ ...settings, density: density.id }) });
    }
    const fetchOn = settings.backgroundFetch.enabled;
    commands.push({
      id: 'fetch:toggle',
      group: 'actions',
      label: fetchOn ? 'Turn background fetch off' : 'Turn background fetch on',
      detail: fetchOn ? undefined : `read-only, every ${settings.backgroundFetch.intervalMinutes} min`,
      keywords: 'git fetch remote',
      icon: 'fetch',
      run: () => ctx.saveSettings({ ...settings, backgroundFetch: { ...settings.backgroundFetch, enabled: !fetchOn } }),
    });
  }
  return commands;
}
