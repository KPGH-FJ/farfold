import { afterEach, expect, it, vi } from "vitest";
import { shortcutLabel } from "./platform_shortcuts";
import { permissionShortcut } from "./permission_shortcuts";
const options: any = [
  { kind: "allow_once", optionId: "once" },
  { kind: "allow_always", optionId: "always" },
  { kind: "reject_once", optionId: "reject" },
];
const event = (args: any = {}) =>
  ({ key: "Enter", metaKey: false, ctrlKey: false, ...args }) as KeyboardEvent;
afterEach(() => vi.unstubAllGlobals());
it.each(["MacIntel", "Win32"])(
  "uses the matching advertised approval shortcut on %s while preserving focused controls",
  (platform) => {
    vi.stubGlobal("navigator", { platform });
    const mac = platform === "MacIntel";
    const primary = mac ? { metaKey: true } : { ctrlKey: true };
    const other = mac ? { ctrlKey: true } : { metaKey: true };
    expect(permissionShortcut(event(), true, options)?.optionId).toBe("once");
    expect(permissionShortcut(event(primary), true, options)?.optionId).toBe(
      "always",
    );
    expect(permissionShortcut(event(other), true, options)).toBeNull();
    expect(
      permissionShortcut(
        event({ ...primary, key: "Backspace" }),
        true,
        options,
      ),
    ).toBeNull();
    expect(
      permissionShortcut(
        event({ ...primary, target: { closest: () => ({}) } }),
        true,
        options,
      ),
    ).toBeNull();
    expect(
      permissionShortcut(
        event({ ...primary, isComposing: true }),
        true,
        options,
      ),
    ).toBeNull();
    expect(shortcutLabel("K")).toBe(mac ? "⌘ K" : "Ctrl+K");
    expect(shortcutLabel("P", true)).toBe(mac ? "⌘ ⇧ P" : "Ctrl+Shift+P");
  },
);
