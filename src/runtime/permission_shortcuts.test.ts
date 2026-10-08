import { expect, it } from "vitest";
import { permissionShortcut } from "./permission_shortcuts";
import type { PermissionOption } from "./session_types";

const options: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow" },
  { optionId: "remember", kind: "allow_always", name: "Remember" },
  { optionId: "no", kind: "reject_once", name: "Reject" },
];
const event = (values: Partial<KeyboardEvent> = {}) =>
  ({ key: "Enter", ...values }) as KeyboardEvent;

it("never approves on bare Enter or Backspace on either platform", () => {
  for (const platform of ["MacIntel", "Win32"]) {
    for (const key of ["Enter", "Backspace"])
      expect(
        permissionShortcut(event({ key }), true, options, platform),
      ).toBeNull();
  }
});

it("maps primary+Enter to allow_once on macOS and Windows", () => {
  expect(
    permissionShortcut(event({ metaKey: true }), true, options, "MacIntel")
      ?.optionId,
  ).toBe("once");
  expect(
    permissionShortcut(event({ ctrlKey: true }), true, options, "Win32")
      ?.optionId,
  ).toBe("once");
  // The other platform's modifier alone is not an approval.
  expect(
    permissionShortcut(event({ ctrlKey: true }), true, options, "MacIntel"),
  ).toBeNull();
  expect(
    permissionShortcut(event({ metaKey: true }), true, options, "Win32"),
  ).toBeNull();
});

it("maps primary+Alt+Enter to allow_always on both platforms", () => {
  expect(
    permissionShortcut(
      event({ metaKey: true, altKey: true }),
      true,
      options,
      "MacIntel",
    )?.optionId,
  ).toBe("remember");
  expect(
    permissionShortcut(
      event({ ctrlKey: true, altKey: true }),
      true,
      options,
      "Win32",
    )?.optionId,
  ).toBe("remember");
});

it("maps primary+Backspace to reject_once on both platforms", () => {
  for (const [platform, modifier] of [
    ["MacIntel", { metaKey: true }],
    ["Win32", { ctrlKey: true }],
  ] as const)
    expect(
      permissionShortcut(
        event({ key: "Backspace", ...modifier }),
        true,
        options,
        platform,
      )?.optionId,
    ).toBe("no");
});

it("rejects incomplete or unrelated modifier combinations", () => {
  for (const platform of ["MacIntel", "Win32"]) {
    for (const values of [
      { altKey: true },
      { altKey: true, key: "Backspace" },
      // Alt+Backspace with the primary modifier is not an approval either.
      platform === "MacIntel"
        ? { altKey: true, metaKey: true, key: "Backspace" }
        : { altKey: true, ctrlKey: true, key: "Backspace" },
      { shiftKey: true },
      platform === "MacIntel"
        ? { metaKey: true, shiftKey: true }
        : { ctrlKey: true, shiftKey: true },
    ] as Partial<KeyboardEvent>[])
      expect(
        permissionShortcut(event(values), true, options, platform),
      ).toBeNull();
  }
  // Both modifiers held at once never counts as the primary shortcut.
  expect(
    permissionShortcut(
      event({ metaKey: true, ctrlKey: true }),
      true,
      options,
      "MacIntel",
    ),
  ).toBeNull();
  expect(
    permissionShortcut(
      event({ metaKey: true, ctrlKey: true }),
      true,
      options,
      "Win32",
    ),
  ).toBeNull();
});

it("only chooses the exact advertised action in an active conversation", () => {
  const mac = "MacIntel";
  for (const key of ["Enter", "Backspace"]) {
    expect(permissionShortcut(event({ key }), false, options, mac)).toBeNull();
    expect(
      permissionShortcut(event({ key, metaKey: true }), false, options, mac),
    ).toBeNull();
  }
  expect(
    permissionShortcut(
      event({ metaKey: true }),
      true,
      options.filter((o) => o.kind !== "allow_once"),
      mac,
    ),
  ).toBeNull();
  expect(
    permissionShortcut(
      event({ metaKey: true, altKey: true }),
      true,
      [options[0]],
      mac,
    ),
  ).toBeNull();
  expect(
    permissionShortcut(
      event({ key: "Backspace", metaKey: true }),
      true,
      [{ optionId: "never", kind: "reject_always", name: "Never" }],
      mac,
    ),
  ).toBeNull();
});

it("leaves controls, composition, and already handled keystrokes to their owner", () => {
  for (const values of [
    { defaultPrevented: true },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { shiftKey: true },
    { ctrlKey: true },
    { target: { isContentEditable: true } },
    ...[
      "button",
      "input",
      "textarea",
      "select",
      "a[href]",
      "[role='button']",
      "[role='link']",
      "[contenteditable]:not([contenteditable='false'])",
    ].map((selector) => ({
      target: {
        closest: (query: string) =>
          query.split(", ").includes(selector) ? {} : null,
      },
    })),
  ]) {
    expect(
      permissionShortcut(
        event({ metaKey: true, ...(values as Partial<KeyboardEvent>) }),
        true,
        options,
        "MacIntel",
      ),
    ).toBeNull();
  }
});
