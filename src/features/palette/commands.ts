// The command palette's model: every repository, screen and non-destructive
// action as one searchable list (DESIGN.md "Command palette"). Pure, so the
// ranking and grouping are unit tested; the component only renders and runs.

import type { RepoSummary } from '../../ipc';
import { branchLabel, primaryReason, reasonText } from '../dashboard/model';
import type { IconName } from '../../components/Icon';

export type CommandGroup = 'repos' | 'screens' | 'actions';

export const GROUP_LABELS: Record<CommandGroup, string> = {
  repos: 'Repositories',
  screens: 'Go to',
  actions: 'Actions',
};

const GROUP_ORDER: CommandGroup[] = ['repos', 'screens', 'actions'];

export interface Command {
  /** Unique within the list; also the option's DOM id suffix. */
  id: string;
  group: CommandGroup;
  label: string;
  /** Secondary text after the label: a repository's branch. */
  detail?: string;
  /** Right-aligned text: a repository's state. */
  meta?: string;
  /** Matched by search but not shown (paths, synonyms). */
  keywords?: string;
  icon: IconName;
  /** Shortcut shown as `kbd`, for example "Ctrl R". */
  shortcut?: string;
  /** Text colour class of the icon and meta (repository state). */
  tone?: string;
  run: () => void;
}

/** A command for one repository: its name, branch and most severe state. */
export function repoCommand(repo: RepoSummary, run: () => void): Command {
  const { reason } = primaryReason(repo);
  const branch = branchLabel(repo);
  const state = reason ? reasonText(reason) : 'Clean';
  return {
    id: `repo:${repo.path}`,
    group: 'repos',
    label: repo.name,
    detail: branch || undefined,
    meta: state,
    keywords: `${repo.path} ${repo.unmergedBranches.map((b) => b.name).join(' ')}`,
    icon: repo.kind.kind === 'linkedWorktree' ? 'worktree' : 'folder',
    tone: `t-${repo.attention.level}`,
    run,
  };
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * How well `command` matches `query`, higher is better; `0` when it does not
 * match. Every query word must appear in the label, detail or keywords; words
 * at the start of the label count most.
 */
export function score(command: Command, query: string): number {
  const terms = words(query);
  if (!terms.length) return 1;
  const label = command.label.toLowerCase();
  const rest = `${command.detail ?? ''} ${command.meta ?? ''} ${command.keywords ?? ''} ${GROUP_LABELS[command.group]}`.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (label === term) total += 100;
    else if (label.startsWith(term)) total += 60;
    else if (new RegExp(`(^|[\\s/:._-])${escape(term)}`).test(label)) total += 40;
    else if (label.includes(term)) total += 25;
    else if (rest.includes(term)) total += 10;
    else return 0;
  }
  return total;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CommandSection {
  group: CommandGroup;
  label: string;
  commands: Command[];
}

/**
 * The commands matching `query`, in sections. Without a query every command
 * is listed in its original order; with one, each section is ranked by score
 * (stable, so equal scores keep the original order) and sections are ordered
 * by their best match.
 */
export function searchCommands(commands: readonly Command[], query: string): CommandSection[] {
  const scored = commands.map((command, index) => ({ command, index, score: score(command, query) })).filter((s) => s.score > 0);
  const sections = GROUP_ORDER.map((group) => {
    const items = scored.filter((s) => s.command.group === group).sort((a, b) => b.score - a.score || a.index - b.index);
    return { group, label: GROUP_LABELS[group], best: items[0]?.score ?? 0, commands: items.map((s) => s.command) };
  }).filter((s) => s.commands.length > 0);
  if (words(query).length) {
    sections.sort((a, b) => b.best - a.best || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }
  return sections.map(({ group, label, commands: list }) => ({ group, label, commands: list }));
}

/** The flat order the arrow keys walk through. */
export const flatCommands = (sections: readonly CommandSection[]) => sections.flatMap((s) => s.commands);

/** The next active index after a key: wraps at both ends; `-1` for an empty list. */
export function moveActive(index: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'PageDown' | 'PageUp' | 'Home' | 'End'): number {
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'PageDown':
      return Math.min(count - 1, index + 8);
    case 'PageUp':
      return Math.max(0, index - 8);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}
