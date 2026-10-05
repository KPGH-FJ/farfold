import { useBrowserSurfaceBarrier } from "../runtime/browser_surface";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const focusable =
  "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex]";
const visible = (element: HTMLElement | null): element is HTMLElement =>
  Boolean(
    element?.isConnected &&
    !element.closest("[hidden], [inert]") &&
    element.getClientRects().length,
  );
const controls = (element: HTMLElement) =>
  Array.from(element.querySelectorAll<HTMLElement>(focusable)).filter(
    (control) =>
      visible(control) &&
      !control.matches(":disabled") &&
      control.tabIndex >= 0,
  );

export function WorkspaceActionMenu({
  anchor,
  title,
  children,
  onClose,
}: {
  anchor: HTMLElement | null;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const browserReady = useBrowserSurfaceBarrier(true);
  const close = useRef(onClose);
  const activeAnchor = useRef(anchor);
  close.current = onClose;
  activeAnchor.current = anchor;
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!browserReady) return;
    if (!visible(anchor)) {
      close.current();
      return;
    }
    if (!panel.current) return;
    const element = panel.current;
    const positionPanel = () => {
      const rect = anchor.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      setPosition({
        left: Math.max(
          12,
          Math.min(
            rect.right - bounds.width,
            window.innerWidth - bounds.width - 12,
          ),
        ),
        top: Math.max(
          12,
          Math.min(
            window.innerHeight - bounds.height - 12,
            rect.bottom + 8 + bounds.height > window.innerHeight - 12
              ? rect.top - bounds.height - 8
              : rect.bottom + 8,
          ),
        ),
      });
    };
    positionPanel();
    (controls(element)[0] ?? element).focus();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(positionPanel);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [anchor, browserReady]);
  useEffect(() => {
    if (!browserReady) return;
    const current = panel.current;
    const outside = (event: MouseEvent) => {
      if (
        !current?.contains(event.target as Node) &&
        !anchor?.contains(event.target as Node)
      )
        close.current();
    };
    const dismiss = () => close.current();
    const scroll = (event: Event) => {
      if (!current?.contains(event.target as Node)) dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!visible(anchor)) {
        dismiss();
        return;
      }
      if (!current?.contains(document.activeElement)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === "Tab") {
        const available = controls(current);
        const edge = event.shiftKey ? available[0] : available.at(-1);
        if (
          !available.length ||
          document.activeElement === edge ||
          document.activeElement === current
        ) {
          event.preventDefault();
          (event.shiftKey ? available.at(-1) : available[0])?.focus();
        }
      }
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scroll, true);
      if (
        activeAnchor.current === anchor &&
        visible(anchor) &&
        (current?.contains(document.activeElement) ||
          document.activeElement === document.body)
      )
        anchor.focus();
    };
  }, [anchor, browserReady]);
  if (!browserReady) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      tabIndex={-1}
      aria-label={title}
      className="workspace-action-menu"
      style={position}
    >
      {children}
    </div>,
    document.body,
  );
}
