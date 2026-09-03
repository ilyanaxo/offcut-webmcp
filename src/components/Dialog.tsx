import { useEffect, useRef, type ReactNode } from 'react';

function restoreFocus(target: HTMLElement | null) {
  if (
    !target?.isConnected ||
    target.matches(':disabled') ||
    target.closest('dialog:not([open]), [inert]') ||
    target.getClientRects().length === 0
  )
    return;
  target.focus();
}

export default function Dialog({
  open,
  onDismiss,
  labelledBy,
  describedBy,
  compact = false,
  returnFocusTo,
  focusKey,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  labelledBy: string;
  describedBy?: string;
  compact?: boolean;
  returnFocusTo?: HTMLElement | null;
  focusKey?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousFocusKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      const opening = !dialog.open;
      if (opening) {
        returnFocusRef.current =
          returnFocusTo ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        dialog.showModal();
      }
      if (opening || previousFocusKey.current !== focusKey) {
        const body = dialog.querySelector<HTMLElement>('.dialog-body');
        if (body) body.scrollTop = 0;
        dialog.querySelector<HTMLElement>('[data-dialog-focus]')?.focus();
      }
    } else if (dialog.open) {
      dialog.close();
      restoreFocus(returnFocusRef.current);
    }
    previousFocusKey.current = focusKey;
  }, [open, focusKey, returnFocusTo]);

  useEffect(
    () => () => {
      if (dialogRef.current?.open) dialogRef.current.close();
      restoreFocus(returnFocusRef.current);
    },
    [],
  );

  return (
    <dialog
      ref={dialogRef}
      className={`workshop-dialog${compact ? ' workshop-dialog--compact' : ''}`}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}
