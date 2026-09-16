import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { canRestoreFocus } from "./focus";

interface Props {
  runtimeName: string;
  title?: string;
  returnFocusSelector?: string;
  description: string;
  closeLocked: boolean;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  onRefresh?: () => void;
  onClose: () => void;
  children: ReactNode;
}

// This container owns presentation and focus only. Authentication and its
// cancellation/commit rules remain with the Runtime-specific settings adapter.
export function ProviderSettingsDialog({
  runtimeName,
  title = "连接模型服务",
  returnFocusSelector = "[data-provider-settings-trigger]",
  description,
  closeLocked,
  refreshing = false,
  refreshDisabled = false,
  onRefresh,
  onClose,
  children,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current!;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element.showModal();
    element.querySelector<HTMLElement>("[data-provider-search]")?.focus();
    return () => {
      element.close();
      // macOS pointer activation does not always focus a button. In that
      // case activeElement was the page, so restore the settings entry.
      const target = canRestoreFocus(previousFocus)
        ? previousFocus
        : document.querySelector<HTMLElement>(returnFocusSelector);
      target?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="connection-settings provider-settings-dialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        event.stopPropagation();
        // WKWebView's search input consumes Escape before native dialog cancel.
        // Keep one close rule, including while focus is in the search field.
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!closeLocked) onClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeLocked) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || closeLocked) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <header>
        <div>
          <span className="settings-eyebrow">{runtimeName}</span>
          <h2 id={titleId}>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="settings-header-actions">
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing || refreshDisabled}
            >
              {refreshing ? "刷新中…" : "刷新"}
            </button>
          )}
          <button
            type="button"
            className="settings-close"
            disabled={closeLocked}
            onClick={onClose}
            aria-label={`关闭 ${runtimeName} 设置`}
          >
            <X size={17} />
          </button>
        </div>
      </header>
      {children}
    </dialog>
  );
}
