import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CaretDownIcon } from "@phosphor-icons/react";

/** Compact controls share one dismissable, keyboard-accessible popup. */
export function WorkspacePopover({
  label,
  title,
  children,
  disabled = false,
  iconOnly = false,
  className = "",
}: {
  label: ReactNode;
  title: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  disabled?: boolean;
  iconOnly?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const browserReady = useBrowserSurfaceBarrier(open);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !browserReady) return;
    const focusFrame = requestAnimationFrame(() =>
      panel.current
        ?.querySelector<HTMLElement>("button, input, select")
        ?.focus(),
    );
    const close = (event: MouseEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    };
    const resize = () => setOpen(false);
    window.addEventListener("resize", resize);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open, browserReady]);
  const toggle = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - 356)),
        top:
          rect.top > window.innerHeight / 2
            ? Math.max(12, rect.top - 370)
            : rect.bottom + 8,
      });
    setOpen(!open);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`workspace-control ${className}${iconOnly ? " workspace-control-icon" : ""}`}
        disabled={disabled}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={toggle}
      >
        {label}
        {!iconOnly && (
          <CaretDownIcon className="workspace-control-chevron" size={11} />
        )}
      </button>
      {open &&
        browserReady &&
        createPortal(
          <div
            ref={panel}
            className="workspace-control-panel"
            style={{
              ...position,
              maxHeight: Math.min(360, window.innerHeight - position.top - 12),
            }}
            role="dialog"
            aria-label={title}
          >
            <div className="workspace-control-title">{title}</div>
            {typeof children === "function"
              ? children(() => {
                  // Preserve a stable return target before this option unmounts
                  // and a following dialog captures the active element.
                  button.current?.focus();
                  setOpen(false);
                })
              : children}
          </div>,
          document.body,
        )}
    </>
  );
}
