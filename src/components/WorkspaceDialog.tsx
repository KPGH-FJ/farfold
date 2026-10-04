import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { LIBRARY } from "../runtime/library_strings";

export function WorkspaceDialog({
  title,
  children,
  onClose,
  returnFocusRef,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const browserReady = useBrowserSurfaceBarrier(true);
  useEffect(() => {
    if (!browserReady) return;
    const previous = returnFocusRef?.current ?? document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    const input = Array.from(
      dialog?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], textarea',
      ) ?? [],
    ).find(
      (element) =>
        !element.matches(":disabled, [readonly]") &&
        !element.closest("[hidden], [inert]") &&
        element.getClientRects().length > 0,
    );
    input?.focus();
    return () => {
      dialog?.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.closest("[hidden], [inert]") &&
        previous.getClientRects().length > 0
      )
        previous.focus();
    };
  }, [browserReady]);
  return (
    <dialog
      className="workspace-dialog"
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="workspace-dialog-title">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.close}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
