// Every keyboard shortcut, in one list: the shortcuts dialog renders it and
// the palette shows the same keys next to its commands (DESIGN.md "Focus and
// keyboard").

export interface Shortcut {
  /** Key names as shown, one `kbd` each: ["Ctrl", "K"]. */
  keys: string[][];
  description: string;
}

export interface ShortcutSection {
  title: string;
  shortcuts: Shortcut[];
}

export const SHORTCUTS: ShortcutSection[] = [
  {
    title: 'Anywhere',
    shortcuts: [
      { keys: [['Ctrl', 'K']], description: 'Open the command palette' },
      { keys: [['Ctrl', 'R']], description: 'Rescan all watched folders' },
      { keys: [['Ctrl', ',']], description: 'Open settings' },
      { keys: [['?']], description: 'Show keyboard shortcuts' },
      { keys: [['Esc']], description: 'Close a dialog or go back' },
    ],
  },
  {
    title: 'Repository list',
    shortcuts: [
      { keys: [['/']], description: 'Search repositories and branches' },
      { keys: [['↑'], ['↓']], description: 'Select the previous or next repository' },
      { keys: [['k'], ['j']], description: 'Same as ↑ and ↓' },
      { keys: [['Home'], ['End']], description: 'Select the first or last repository' },
      { keys: [['Page Up'], ['Page Down']], description: 'Move ten repositories' },
      { keys: [['Enter']], description: 'Open the repository' },
    ],
  },
  {
    title: 'Repository',
    shortcuts: [
      { keys: [['1'], ['2'], ['3'], ['4']], description: 'Changes, Branches, Stashes, Lost commits' },
      { keys: [['Space']], description: 'Stage or unstage the focused file' },
      { keys: [['Ctrl', 'Enter']], description: 'Commit (in the message field)' },
      { keys: [['Esc']], description: 'Back to all repositories' },
    ],
  },
  {
    title: 'Command palette',
    shortcuts: [
      { keys: [['↑'], ['↓']], description: 'Move through the results' },
      { keys: [['Enter']], description: 'Run the highlighted command' },
      { keys: [['Esc']], description: 'Close and return to where you were' },
    ],
  },
];
