import { primaryShortcutHeld, usesMacShortcuts } from "./platform_shortcuts";
import type { PermissionOption } from "./session_types";

/** Approval shortcuts belong to the visible conversation, never to a control. */
export function permissionShortcut(
  event: KeyboardEvent,
  active: boolean,
  options: PermissionOption[],
): PermissionOption | null {
  if (
    !active ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.altKey ||
    (usesMacShortcuts() ? event.ctrlKey : event.metaKey) ||
    event.shiftKey
  )
    return null;
  const target = event.target as HTMLElement | null;
  if (
    target?.isContentEditable ||
    target?.closest?.(
      "input, textarea, select, button, a[href], [role='button'], [role='link'], [contenteditable]:not([contenteditable='false'])",
    )
  )
    return null;
  const kind =
    event.key === "Enter"
      ? primaryShortcutHeld(event)
        ? "allow_always"
        : "allow_once"
      : event.key === "Backspace" && !primaryShortcutHeld(event)
        ? "reject_once"
        : null;
  return options.find((option) => option.kind === kind) ?? null;
}
