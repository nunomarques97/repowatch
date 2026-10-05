// Every keyboard shortcut in one dialog (`?`, the palette, or Settings).

import { Icon } from '../../components/Icon';
import { Modal } from './Modal';
import { SHORTCUTS } from './shortcuts';

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal className="sheet shortcuts" labelledBy="shortcuts-title" onClose={onClose}>
      <div className="sheet-head">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <span className="spacer" />
        <button className="btn ghost icon-only" type="button" aria-label="Close" onClick={onClose} data-autofocus>
          <Icon name="close" />
        </button>
      </div>
      <div className="shortcuts-body">
        {SHORTCUTS.map((section, n) => (
          <section key={section.title} aria-labelledby={`keys-${n}`}>
            <h3 className="section" id={`keys-${n}`}>
              {section.title}
            </h3>
            <dl>
              {section.shortcuts.map((shortcut) => (
                <div key={shortcut.description}>
                  <dt>
                    {shortcut.keys.map((combo, i) => (
                      <span key={combo.join('+')} className="combo">
                        {i > 0 && <span className="or">or</span>}
                        {combo.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </span>
                    ))}
                  </dt>
                  <dd>{shortcut.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
