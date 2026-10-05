import { describe, expect, it, vi } from 'vitest';
import { createMockClient } from '../../ipc/mock';
import { defaultSettings } from '../../ipc/mock-data';
import type { Settings } from '../../ipc';
import { buildCommands, type CommandContext } from './appCommands';
import { flatCommands, moveActive, score, searchCommands, type Command } from './commands';
import { SHORTCUTS } from './shortcuts';

async function context(overrides: Partial<CommandContext> = {}): Promise<CommandContext> {
  const snapshot = await createMockClient().scan();
  return {
    repos: snapshot.repos,
    screen: 'dashboard',
    settings: defaultSettings('default'),
    filter: 'attention',
    sort: 'attention',
    selected: snapshot.repos[0] ?? null,
    openRepo: vi.fn(),
    showDashboard: vi.fn(),
    showSettings: vi.fn(),
    showShortcuts: vi.fn(),
    rescan: vi.fn(),
    addFolder: vi.fn(),
    focusSearch: vi.fn(),
    setFilter: vi.fn(),
    setSort: vi.fn(),
    saveSettings: vi.fn(),
    openIn: vi.fn(),
    ...overrides,
  };
}

const command = (label: string, extra: Partial<Command> = {}): Command => ({
  id: label,
  group: 'actions',
  label,
  icon: 'go',
  run: () => undefined,
  ...extra,
});

describe('palette search', () => {
  it('lists every command in its group order without a query', () => {
    const list = [command('b', { group: 'actions' }), command('a', { group: 'repos' }), command('c', { group: 'screens' })];
    const sections = searchCommands(list, '  ');
    expect(sections.map((s) => s.label)).toEqual(['Repositories', 'Go to', 'Actions']);
    expect(flatCommands(sections).map((c) => c.label)).toEqual(['a', 'c', 'b']);
  });

  it('requires every word and ranks label starts above other matches', () => {
    expect(score(command('Rescan all folders'), 'resc')).toBeGreaterThan(score(command('Show all rescans'), 'resc'));
    expect(score(command('Rescan all folders'), 'all fold')).toBeGreaterThan(0);
    expect(score(command('Rescan all folders'), 'all nothing')).toBe(0);
    // Detail and keywords match, below the label.
    expect(score(command('forja', { detail: 'main', keywords: 'C:\\code\\forja' }), 'code')).toBeGreaterThan(0);
    expect(score(command('api'), 'API')).toBe(100);
  });

  it('puts the section with the best match first and keeps equal scores in order', () => {
    const list = [
      command('settings-sync', { group: 'repos' }),
      command('Settings', { group: 'screens' }),
      command('Use the dark theme', { keywords: 'settings' }),
    ];
    const sections = searchCommands(list, 'settings');
    expect(sections[0]?.group).toBe('screens');
    expect(flatCommands(sections)).toHaveLength(3);
  });

  it('treats regular expression characters in a query as text', () => {
    expect(score(command('feature/(x)'), '(x')).toBeGreaterThan(0);
    expect(score(command('a.b'), '.*')).toBe(0);
  });

  it('moves the highlight with wrapping arrows and clamped pages', () => {
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2);
    expect(moveActive(2, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(1, 20, 'PageDown')).toBe(9);
    expect(moveActive(18, 20, 'PageDown')).toBe(19);
    expect(moveActive(3, 20, 'PageUp')).toBe(0);
    expect(moveActive(0, 0, 'ArrowDown')).toBe(-1);
    expect(moveActive(5, 6, 'Home')).toBe(0);
    expect(moveActive(0, 6, 'End')).toBe(5);
  });
});

describe('palette commands', () => {
  it('reaches every repository, by name, branch or path', async () => {
    const ctx = await context();
    const commands = buildCommands(ctx);
    for (const repo of ctx.repos) {
      expect(commands.some((c) => c.id === `repo:${repo.path}`)).toBe(true);
      const found = flatCommands(searchCommands(commands, repo.name));
      expect(found[0]?.label).toBe(repo.name);
    }
    const forja = ctx.repos.find((r) => r.name === 'forja')!;
    commands.find((c) => c.id === `repo:${forja.path}`)!.run();
    expect(ctx.openRepo).toHaveBeenCalledWith(forja.path);
    expect(flatCommands(searchCommands(commands, 'feature/auth')).map((c) => c.label)).toContain('api');
  });

  it('reaches every screen from the dashboard and from settings', async () => {
    const onDashboard = buildCommands(await context()).map((c) => c.id);
    expect(onDashboard).toEqual(expect.arrayContaining(['go:settings', 'go:shortcuts']));
    expect(onDashboard).not.toContain('go:dashboard');
    const onSettings = buildCommands(await context({ screen: 'settings' })).map((c) => c.id);
    expect(onSettings).toEqual(expect.arrayContaining(['go:dashboard', 'go:shortcuts']));
    expect(onSettings).not.toContain('go:settings');
  });

  it('offers only non-destructive actions, and none that would change nothing', async () => {
    const ctx = await context();
    const commands = buildCommands(ctx);
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of commands) {
      expect(c.id).not.toMatch(/delete|drop|push|pull|commit|stage|switch|recover|apply|reset|force/i);
      if (c.group === 'actions') expect(c.label).not.toMatch(/^(delete|drop|push|pull|commit|stage|discard|recover|force)\b/i);
    }
    // The current filter, sort, theme and density are not offered again.
    expect(ids).not.toContain('filter:attention');
    expect(ids).not.toContain('sort:attention');
    expect(ids).not.toContain('theme:system');
    expect(ids).not.toContain('density:compact');
    expect(ids).toEqual(expect.arrayContaining(['act:rescan', 'act:add-folder', 'act:search', 'filter:all', 'sort:name', 'theme:dark', 'density:comfortable', 'fetch:toggle']));
  });

  it('changes settings through saveSettings, from the current values', async () => {
    const ctx = await context();
    const commands = buildCommands(ctx);
    commands.find((c) => c.id === 'fetch:toggle')!.run();
    const saved = vi.mocked(ctx.saveSettings).mock.calls[0]?.[0] as Settings;
    expect(saved.backgroundFetch).toEqual({ enabled: true, intervalMinutes: 30 });
    expect(saved.roots).toEqual(ctx.settings!.roots);
    const on = buildCommands(await context({ settings: { ...ctx.settings!, backgroundFetch: { enabled: true, intervalMinutes: 30 } } }));
    expect(on.find((c) => c.id === 'fetch:toggle')!.label).toBe('Turn background fetch off');
  });

  it('opens the selected repository in other apps, never one that could not be read', async () => {
    const ctx = await context();
    const healthy = ctx.repos.find((r) => !r.error)!;
    const broken = ctx.repos.find((r) => r.error)!;
    const commands = buildCommands({ ...ctx, selected: healthy });
    commands.find((c) => c.id === 'open:vsCode')!.run();
    expect(ctx.openIn).toHaveBeenCalledWith(healthy.path, 'vsCode');
    expect(buildCommands({ ...ctx, selected: broken }).some((c) => c.id.startsWith('open:'))).toBe(false);
    expect(buildCommands({ ...ctx, selected: null }).some((c) => c.id.startsWith('open:'))).toBe(false);
  });

  it('builds without settings or repositories', async () => {
    const commands = buildCommands(await context({ repos: [], settings: null, selected: null }));
    expect(commands.some((c) => c.group === 'repos')).toBe(false);
    expect(commands.map((c) => c.id)).toContain('act:rescan');
  });
});

describe('shortcuts', () => {
  it('documents the palette and every app-wide key', () => {
    const described = SHORTCUTS.flatMap((s) => s.shortcuts.map((x) => x.keys.map((k) => k.join('+')).join(' ')));
    expect(described).toEqual(expect.arrayContaining(['Ctrl+K', 'Ctrl+R', 'Ctrl+,', '?', '/', 'Esc']));
  });
});
