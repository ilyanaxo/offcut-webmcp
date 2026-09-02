import { useEffect, useRef, type ReactNode } from 'react';

export default function Dialog({
  open,
  onDismiss,
  labelledBy,
  describedBy,
  compact = false,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  labelledBy: string;
  describedBy?: string;
  compact?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-dialog-focus]')?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    }
  }, [open]);

  useEffect(
    () => () => {
      if (dialogRef.current?.open) dialogRef.current.close();
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
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
