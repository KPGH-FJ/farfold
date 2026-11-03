import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import {
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { LIBRARY } from "../runtime/library_strings";
import { hasOpenDisclosureAncestors } from "../runtime/disclosure_ancestry";
import { useModalDialog } from "./useModalDialog";

const TAB_STOPS =
  "button, input, select, textarea, a[href], summary, [tabindex]";

function wrapTab(event: KeyboardEvent<HTMLDialogElement>) {
  const { currentTarget: dialog, target, shiftKey } = event;
  if (
    event.key !== "Tab" ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(target instanceof HTMLElement) ||
    target.closest("dialog") !== dialog
  )
    return;
  const controls = Array.from(dialog.querySelectorAll<HTMLElement>(TAB_STOPS));
  const available = (control: HTMLElement) =>
    (control.tabIndex >= 0 ||
      control.matches("details > summary:first-of-type:not([tabindex])")) &&
    !control.matches(":disabled") &&
    !control.closest("[inert]") &&
    hasOpenDisclosureAncestors(control, dialog) &&
    control.getClientRects().length > 0 &&
    getComputedStyle(control).visibility === "visible";
  const first = controls.find(available);
  const last = controls.reverse().find(available);
  // WebKit can send the next Tab to the viewport at a native dialog edge.
  if (target === dialog || target === (shiftKey ? first : last)) {
    event.preventDefault();
    (shiftKey ? last : first)?.focus();
  }
}

export function WorkspaceDialog({
  title,
  children,
  onClose,
  returnFocusRef,
  returnFocusWhen,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  returnFocusWhen?: () => boolean;
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
    returnFocusWhen,
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
      onKeyDown={wrapTab}
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
