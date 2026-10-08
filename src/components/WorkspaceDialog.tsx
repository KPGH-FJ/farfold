import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import { useRef, type ReactNode, type RefObject } from "react";
import { LIBRARY } from "../runtime/library_strings";
import { useModalDialog } from "./useModalDialog";

export function WorkspaceDialog({
  title,
  children,
  onClose,
  returnFocusRef,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** In-flight work locks Escape, backdrop and the close control. */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const browserReady = useBrowserSurfaceBarrier(true);
  const { onCancel, onClick } = useModalDialog({
    dialogRef: ref,
    open: browserReady,
    busy,
    onDismiss: onClose,
    returnFocusRef,
    autoFocus: true,
    backdropDismiss: true,
  });
  return (
    <dialog
      className="workspace-dialog"
      ref={ref}
      aria-label={title}
      aria-busy={busy || undefined}
      onCancel={onCancel}
      onClick={onClick}
    >
      <div className="workspace-dialog-title">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.close}
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
