/**
 * Shared native <dialog> lifecycle for every modal surface: showModal/close on
 * `open`, opener focus capture and return, first-field focus, Escape handling,
 * and an optional backdrop click dismissal. Escape, backdrop and the dismiss
 * path stay locked while `busy` (destructive or in-flight work).
 * Surfaces keep their own markup, classes and aria labelling; this hook only
 * converges behavior.
 */
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

import { hasOpenDisclosureAncestors } from "../runtime/disclosure_ancestry";

const TAB_STOPS =
  "button, input, select, textarea, a[href], summary, [tabindex]";

export function wrapModalTab(event: KeyboardEvent<HTMLDialogElement>) {
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

/** Text-like fields that should receive the default dialog focus. */
const AUTO_FOCUS_SELECTOR =
  'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], textarea';

function firstAutoFocus(dialog: HTMLDialogElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      AUTO_FOCUS_SELECTOR,
    ),
  ).find(
    (element) =>
      !element.matches(":disabled, [readonly]") &&
      !element.closest("[hidden], [inert]") &&
      element.getClientRects().length > 0,
  );
}

function focusable(target: unknown): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    target.isConnected &&
    !target.closest("[hidden], [inert]") &&
    target.getClientRects().length > 0
  );
}

export interface CancelEventLike {
  target?: unknown;
  currentTarget?: unknown;
  preventDefault(): void;
  stopPropagation?(): void;
}

export function useModalDialog({
  dialogRef,
  open = true,
  busy = false,
  onDismiss,
  returnFocusRef,
  returnFocusWhen,
  fallbackFocusRef,
  initialFocusRef,
  focusSelector,
  autoFocus = false,
  backdropDismiss = false,
  deferFocusReturn = false,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  /** Toggling to false closes the dialog and still returns focus. */
  open?: boolean;
  /** In-flight or destructive work locks Escape and backdrop dismissal. */
  busy?: boolean;
  onDismiss?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** An obsolete owner must not return focus into a replacement surface. */
  returnFocusWhen?: () => boolean;
  /** Focus target when the recorded opener is gone (e.g. unmounted button). */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Focused after showModal; takes precedence over any selector scan. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Custom first-focus selector; defaults to eligible text inputs. */
  focusSelector?: string;
  /** Without an explicit focus target, focus the first eligible text input. */
  autoFocus?: boolean;
  /** Outside-click dismisses while not busy. */
  backdropDismiss?: boolean;
  /**
   * Nested-dialog variant: defer the focus return a microtask so an inner
   * confirm closes first, and yield to any still-open dialog.
   */
  deferFocusReturn?: boolean;
}) {
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const returnFocusWhenRef = useRef(returnFocusWhen);
  returnFocusWhenRef.current = returnFocusWhen;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open) {
      dialog?.close();
      return;
    }
    // A pointer click on macOS need not focus its button. Keep the actual opener.
    const previous = returnFocusRef?.current ?? document.activeElement;
    dialog?.showModal();
    // React autoFocus runs before showModal, while controls are still hidden.
    const field =
      initialFocusRef?.current ??
      (dialog
        ? focusSelector
          ? dialog.querySelector<HTMLElement>(focusSelector)
          : autoFocus
            ? firstAutoFocus(dialog)
            : undefined
        : undefined);
    field?.focus();
    return () => {
      dialog?.close();
      const apply = () => {
        if (returnFocusWhenRef.current?.() === false) return;
        const target =
          previous instanceof HTMLElement && previous.isConnected
            ? previous
            : fallbackFocusRef?.current;
        if (!focusable(target)) return;
        if (deferFocusReturn) {
          // A newly opened dialog or a hidden Settings page keeps ownership.
          const modal = Array.from(
            document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
          );
          if (modal.some((item) => !item.contains(target))) return;
        }
        target.focus();
      };
      if (deferFocusReturn) queueMicrotask(apply);
      else apply();
    };
    // The lifecycle only reacts to `open`; refs and callbacks are read lazily.
  }, [open]);

  const onCancel = (event: CancelEventLike) => {
    // A nested dialog consumes its own cancel before this one sees it.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation?.();
    if (!busyRef.current) dismissRef.current?.();
  };

  const onClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (
      !backdropDismiss ||
      busyRef.current ||
      event.target !== dialogRef.current
    )
      return;
    const bounds = dialogRef.current.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dismissRef.current?.();
  };

  return { onCancel, onClick };
}
