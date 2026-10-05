// The confirmation of a dangerous action (DESIGN.md "Confirmation dialog"):
// the title names the action and its target, the body says the exact
// consequence and how to undo it, Cancel has focus first and the confirm
// button carries the action's own verb. Cancel, Esc and the backdrop close it
// and nothing runs; the confirm button runs the action once.

import { useId, useRef, type FormEvent, type ReactNode } from 'react';
import { Modal } from '../features/palette/Modal';

interface ConfirmDialogProps {
  title: string;
  body: string;
  verb: string;
  tone: 'ink' | 'danger';
  /** Fields of the action, for example the new branch name. */
  children?: ReactNode;
  /** Why the action cannot run as entered; the confirm button says so instead of running. */
  problem?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, body, verb, tone, children, problem = null, onConfirm, onCancel }: ConfirmDialogProps) {
  const id = useId();
  const done = useRef(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (done.current || problem) return;
    done.current = true;
    onConfirm();
  };
  const close = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  return (
    <Modal className="confirm" labelledBy={`${id}-title`} onClose={close}>
      <form onSubmit={submit} aria-describedby={`${id}-body`}>
        <h2 id={`${id}-title`} className="confirm-title">
          {title}
        </h2>
        <p id={`${id}-body`} className="confirm-body">
          {body}
        </p>
        {children}
        <div className="confirm-actions">
          <button type="button" className="btn" data-autofocus onClick={close}>
            Cancel
          </button>
          <button type="submit" className={`btn ${tone}`} aria-disabled={problem ? true : undefined}>
            {verb}
          </button>
        </div>
      </form>
    </Modal>
  );
}
