// The command palette (Ctrl K): one search over every repository, screen and
// non-destructive action. The input keeps focus; the arrow keys move the
// highlighted option (`aria-activedescendant`), Enter runs it, Esc closes and
// focus returns to where it was.

import { useLayoutEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { buildCommands, type CommandContext } from './appCommands';
import { Modal } from './Modal';
import { flatCommands, moveActive, searchCommands, type Command } from './commands';

interface CommandPaletteProps {
  /** The app state and callbacks the commands are built from. */
  context: CommandContext;
  /** Closes the palette; `command` is the one chosen, if any, run after closing. */
  onClose: (command?: Command) => void;
}

// By position in the flat list: command ids hold repository paths, which do not make unique DOM ids.
const optionId = (index: number) => `palette-option-${index}`;

export function CommandPalette({ context, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  // The highlighted command by id, so a refresh of the list keeps it.
  const [activeId, setActiveId] = useState<string | null>(null);

  const sections = searchCommands(buildCommands(context), query);
  const flat = flatCommands(sections);
  const activeIndex = Math.max(0, flat.findIndex((c) => c.id === activeId));
  const active = flat[activeIndex] ?? null;

  useLayoutEffect(() => {
    if (!active) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }, [active, activeIndex]);

  const choose = (command: Command | null) => {
    if (command) onClose(command);
  };

  const total = flat.length;
  const resultText = query.trim()
    ? total === 0
      ? 'No results'
      : `${total} ${total === 1 ? 'result' : 'results'}`
    : '';

  return (
    <Modal className="palette" labelledBy="palette-title" onClose={() => onClose()}>
      <h2 id="palette-title" className="sr-only">
        Command palette
      </h2>
      <div className="palette-field">
        <Icon name="search" />
        <input
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(activeIndex) : undefined}
          aria-label="Search repositories, screens and actions"
          placeholder="Search repositories, screens and actions"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId(null);
          }}
          onKeyDown={(event) => {
            switch (event.key) {
              case 'ArrowDown':
              case 'ArrowUp':
              case 'PageDown':
              case 'PageUp': {
                event.preventDefault();
                const next = flat[moveActive(activeIndex, total, event.key)];
                if (next) setActiveId(next.id);
                return;
              }
              case 'Enter':
                event.preventDefault();
                if (!event.nativeEvent.isComposing) choose(active);
                return;
            }
          }}
        />
        <kbd aria-hidden="true">Esc</kbd>
      </div>
      <div className="palette-list" id="palette-list" role="listbox" aria-label="Results">
        {sections.map((section) => (
          <div key={section.group} role="group" aria-labelledby={`palette-${section.group}`}>
            <div className="palette-group" id={`palette-${section.group}`} role="presentation">
              {section.label}
            </div>
            {section.commands.map((command) => (
              <div
                key={command.id}
                id={optionId(flat.indexOf(command))}
                role="option"
                aria-selected={command === active}
                className={`palette-option g-${command.group}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => command !== active && setActiveId(command.id)}
                onClick={() => choose(command)}
              >
                <Icon name={command.icon} className={command.tone} />
                <span className="palette-label">{command.label}</span>
                {command.detail && <span className="palette-detail">{command.detail}</span>}
                <span className="spacer" />
                {command.meta && (
                  <span className={command.tone ? `palette-meta ${command.tone}` : 'palette-meta'}>
                    {command.meta}
                  </span>
                )}
                {command.shortcut && (
                  <span className="palette-keys" aria-label={`Shortcut ${command.shortcut}`}>
                    {command.shortcut.split(' ').map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
        {total === 0 && (
          <p className="palette-empty">
            Nothing matches <span className="mono">“{query.trim()}”</span>. Try a repository name, a branch, or a word
            like “settings” or “rescan”.
          </p>
        )}
      </div>
      <div className="palette-foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> run
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {resultText}
      </div>
    </Modal>
  );
}
