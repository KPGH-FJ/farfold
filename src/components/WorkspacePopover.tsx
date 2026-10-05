import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    maxHeight: 360,
  });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !browserReady) return;
    const anchor = button.current;
    const element = panel.current;
    if (!anchor || !element) return;
    const positionPanel = () => {
      const rect = anchor.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const height = Math.min(
        360,
        Math.max(bounds.height, element.scrollHeight),
      );
      const below = Math.max(0, window.innerHeight - rect.bottom - 20);
      const above = Math.max(0, rect.top - 20);
      const downward = below >= height || below >= above;
      const maxHeight = Math.min(360, downward ? below : above);
      const top = downward
        ? rect.bottom + 8
        : Math.max(12, rect.top - Math.min(height, maxHeight) - 8);
      const left = Math.max(
        12,
        Math.min(rect.left, window.innerWidth - bounds.width - 12),
      );
      setPosition((previous) =>
        previous.top === top &&
        previous.left === left &&
        previous.maxHeight === maxHeight
          ? previous
          : { top, left, maxHeight },
      );
    };
    positionPanel();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(positionPanel);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [open, browserReady, children]);
  useLayoutEffect(() => {
    if (!open || !browserReady) return;
    (
      panel.current?.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
      ) ?? panel.current
    )?.focus();
  }, [open, browserReady]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open || !browserReady) return;
    const close = (event: Event) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    };
    const resize = () => setOpen(false);
    const scroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("resize", resize);
    window.addEventListener("mousedown", close);
    window.addEventListener("focusin", close);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("focusin", close);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("keydown", key);
    };
  }, [open, browserReady]);
  const toggle = () => setOpen(!open);
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
        aria-haspopup="dialog"
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
            style={position}
            tabIndex={-1}
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
