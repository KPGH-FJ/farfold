import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { WorkspacePopoverScope } from "./WorkspacePopoverScope";
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
  const childPanels = useRef(new Set<HTMLElement>());
  const scope = useMemo(
    () => ({
      register: (element: HTMLElement) => {
        childPanels.current.add(element);
        return () => {
          childPanels.current.delete(element);
        };
      },
    }),
    [],
  );
  const containsChild = (target: EventTarget | null) =>
    [...childPanels.current].some((element) =>
      element.contains(target as Node),
    );
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
    const element = panel.current;
    if (!element) return;
    const activeWhenScheduled = document.activeElement;
    // Position state commits before this frame; later content changes must not
    // pull focus away from the user's current control.
    const frame = requestAnimationFrame(() => {
      if (
        panel.current !== element ||
        !element.isConnected ||
        document.activeElement !== activeWhenScheduled
      )
        return;
      const candidate = element.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), summary",
      );
      const bounds = element.getBoundingClientRect();
      const top = bounds.top + element.clientTop;
      const left = bounds.left + element.clientLeft;
      const rect = candidate?.getBoundingClientRect();
      const visible =
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= top &&
        rect.bottom <= top + element.clientHeight &&
        rect.left >= left &&
        rect.right <= left + element.clientWidth;
      (visible ? candidate : element)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, browserReady]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open || !browserReady) return;
    const close = (event: Event) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node) &&
        !containsChild(event.target)
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
      if (
        !panel.current?.contains(event.target as Node) &&
        !containsChild(event.target)
      )
        setOpen(false);
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
            <WorkspacePopoverScope.Provider
              value={{ ...scope, host: document.body }}
            >
              {typeof children === "function"
                ? children(() => {
                    // Preserve a stable return target before this option unmounts
                    // and a following dialog captures the active element.
                    button.current?.focus();
                    setOpen(false);
                  })
                : children}
            </WorkspacePopoverScope.Provider>
          </div>,
          document.body,
        )}
    </>
  );
}
