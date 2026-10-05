/** UI hints and key interpretation only, never platform/security authority. */
export function usesMacShortcuts(
  platform = typeof navigator === "undefined" ? "Mac" : navigator.platform,
): boolean {
  // The two supported desktop platforms; keep the existing Mac hints when a
  // renderer/test environment does not report an operating system.
  return !/win/i.test(platform);
}
export function shortcutLabel(
  key: string,
  shift = false,
  platform?: string,
): string {
  return usesMacShortcuts(platform)
    ? `⌘ ${shift ? "⇧ " : ""}${key}`
    : `Ctrl${shift ? "+Shift" : ""}+${key}`;
}
export function primaryShortcutHeld(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return usesMacShortcuts(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
