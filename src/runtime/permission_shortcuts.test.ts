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

it("only chooses the exact advertised action in an active conversation", () => {
  expect(permissionShortcut(event(), true, options)?.optionId).toBe("once");
  expect(
    permissionShortcut(event({ metaKey: true }), true, options)?.optionId,
  ).toBe("remember");
  expect(
    permissionShortcut(event({ key: "Backspace" }), true, options)?.optionId,
  ).toBe("no");
  for (const key of ["Enter", "Backspace"]) {
    expect(permissionShortcut(event({ key }), false, options)).toBeNull();
    expect(
      permissionShortcut(event({ key, metaKey: true }), false, options),
    ).toBeNull();
  }
  expect(
    permissionShortcut(
      event(),
      true,
      options.filter((o) => o.kind !== "allow_once"),
    ),
  ).toBeNull();
  expect(
    permissionShortcut(event({ metaKey: true }), true, [options[0]]),
  ).toBeNull();
  expect(
    permissionShortcut(event({ key: "Backspace" }), true, [
      { optionId: "never", kind: "reject_always", name: "Never" },
    ]),
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
    { altKey: true },
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
        event(values as Partial<KeyboardEvent>),
        true,
        options,
      ),
    ).toBeNull();
  }
});
