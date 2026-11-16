import { primaryShortcutHeld, usesMacShortcuts } from "./platform_shortcuts";
import type { PermissionOption } from "./session_types";
import { selectablePermissionOption } from "./permission_options";

/** Approval shortcuts belong to the visible conversation, never to a control.
 *  Bare Enter/Backspace never decide: every approval needs the platform
 *  primary modifier (⌘ / Ctrl). Alt is a secondary modifier for
 *  "allow_always" only. */
export function permissionShortcut(
  event: KeyboardEvent,
  active: boolean,
  options: PermissionOption[],
  platform?: string,
): PermissionOption | null {
  if (
    !active ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.shiftKey ||
    (usesMacShortcuts(platform) ? event.ctrlKey : event.metaKey)
  )
    return null;
  const primary = primaryShortcutHeld(event, platform);
  if (!primary || (event.altKey && event.key !== "Enter")) return null;
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
      ? event.altKey
        ? "allow_always"
        : "allow_once"
      : event.key === "Backspace"
        ? "reject_once"
        : null;
  return (
    options.find(
      (option) =>
        option.kind === kind && selectablePermissionOption(options, option),
    ) ?? null
  );
}
