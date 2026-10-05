// A modal layer on the native <dialog> (DESIGN.md "Command palette"): the
// browser keeps focus inside and makes the window behind it inert. Esc and a
// click on the backdrop close it; on close, focus goes back to the element
// that had it when the layer opened, so the user continues where they were.

import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  className: string;
  /** Id of the element naming the dialog. */
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ className, labelledBy, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // showModal focuses the first focusable element; `autoFocus` children take it.
    dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
      // Back where the user was, unless the element is gone (then whatever
      // the next screen focuses wins).
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // Handled here, so the window's Esc (back from Settings) does not also run.
          event.preventDefault();
          event.stopPropagation();
          close.current();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onMouseDown={(event) => {
        // The dialog element itself is only hit outside its content: the backdrop.
        if (event.target === ref.current) close.current();
      }}
    >
      {children}
    </dialog>
  );
}
