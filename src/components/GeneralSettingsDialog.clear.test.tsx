import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown }[],
  invoke: vi.fn(),
  running: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === "function"
            ? (next as (v: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useRef: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: { current: initial } });
    return slot.value;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../runtime/sessions", () => ({
  threads: {
    subscribe: () => () => {},
    getSnapshot: () => ({
      index: [],
      threads: new Map(
        h.running
          ? [
              [
                "t1",
                {
                  key: "t1",
                  running: true,
                  submitting: false,
                  stopping: false,
                  stopUnconfirmed: false,
                  uncertainPrompt: false,
                  connectionOutcomeUnknown: false,
                  pendingPermissions: [],
                  pendingElicitations: [],
                  browserReadRequestId: null,
                },
              ],
            ]
          : [],
      ),
    }),
  },
}));
import { GeneralSettingsDialog } from "./GeneralSettingsDialog";
import { SETTINGS_PRESENTATION as P } from "../runtime/settings_presentation_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";

type Element = ReactElement<Record<string, unknown>>;
function render() {
  h.cursor = 0;
  const tree = GeneralSettingsDialog({
    page: "privacy",
    onClose: () => {},
  });
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      // Expand the colocated controls; other nested components stay opaque.
      if (
        typeof child.type === "function" &&
        (child.type.name === "PrivacyDataControls" ||
          child.type.name === "DangerConfirm")
      ) {
        visit(
          (child.type as (p: Record<string, unknown>) => ReactNode)(
            child.props,
          ),
        );
        return;
      }
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return elements;
}
function button(label: string) {
  return render().find(
    (node) => node.type === "button" && node.props.children === label,
  );
}
function acknowledge() {
  const checkbox = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (checkbox.props.onChange as (event: unknown) => void)({
    target: { checked: true },
  });
}
beforeEach(() => {
  h.slots = [];
  h.running = false;
  h.invoke.mockReset().mockResolvedValue(undefined);
});

it("offers the clear action with its scope only after an explicit confirmation", async () => {
  const idle = render();
  const clear = button(P.clearData)!;
  expect(clear.props.disabled).toBe(false);
  expect(
    idle.some(
      (node) =>
        node.type === "strong" &&
        node.props.children === P.clearDataDeleteTitle,
    ),
  ).toBe(false);
  // Complete-uninstall guidance lives in the same section.
  expect(idle.some((node) => node.props.children === P.uninstallTitle)).toBe(
    true,
  );
  expect(idle.some((node) => node.props.children === P.uninstallHint)).toBe(
    true,
  );

  (clear.props.onClick as () => void)();
  const confirm = render();
  for (const item of P.clearDataDeletes)
    expect(confirm.some((node) => node.props.children === item)).toBe(true);
  for (const item of P.clearDataKeeps)
    expect(confirm.some((node) => node.props.children === item)).toBe(true);
  acknowledge();
  (button(P.clearDataConfirm)!.props.onClick as () => void)();
  await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledOnce());
  expect(h.invoke).toHaveBeenCalledWith("farfold_data_clear");
  await vi.waitFor(() =>
    expect(
      render().some((node) => node.props.children === P.clearDataDone),
    ).toBe(true),
  );
});

it("keeps the confirmation open and reports a partial failure honestly", async () => {
  h.invoke.mockRejectedValueOnce(new Error("keychain refused"));
  (button(P.clearData)!.props.onClick as () => void)();
  acknowledge();
  (button(P.clearDataConfirm)!.props.onClick as () => void)();
  await vi.waitFor(() =>
    expect(
      render().some(
        (node) =>
          node.props.role === "alert" &&
          node.props.children === P.clearDataFailed,
      ),
    ).toBe(true),
  );
  // Still in the confirm phase: the user can retry or cancel.
  expect(button(P.clearDataConfirm)).toBeDefined();
  expect(render().some((node) => node.props.children === P.clearDataDone)).toBe(
    false,
  );
});

it("locks the action while work or unconfirmed results are in flight", () => {
  h.running = true;
  const nodes = render();
  const clear = button(P.clearData)!;
  expect(clear.props.disabled).toBe(true);
  expect(nodes.some((node) => node.props.children === P.clearDataBlocked)).toBe(
    true,
  );
  expect(nodes.some((node) => node.props.children === P.clearDataConfirm)).toBe(
    false,
  );
});

it("locks the entire dialog and footer until clear and restart complete", async () => {
  let finish!: () => void;
  h.invoke.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  (button(P.clearData)!.props.onClick as () => void)();
  acknowledge();
  const confirm = button(P.clearDataConfirm)!.props.onClick as () => void;
  confirm();
  confirm();
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(
    render().find((node) => node.type === WorkspaceDialog)?.props.busy,
  ).toBe(true);
  expect(button(P.understood)?.props.disabled).toBe(true);
  finish();
  await vi.waitFor(() =>
    expect(
      render().some((node) => node.props.children === P.clearDataDone),
    ).toBe(true),
  );
  // Successful clear must not return the user to stores from before the clear.
  expect(
    render().find((node) => node.type === WorkspaceDialog)?.props.busy,
  ).toBe(true);
  expect(button(P.understood)?.props.disabled).toBe(true);
});

it("requires scope acknowledgement and rechecks work before a stale clear handler can run", () => {
  (button(P.clearData)!.props.onClick as () => void)();
  expect(button(P.clearDataConfirm)!.props.disabled).toBe(true);
  (button(P.clearDataConfirm)!.props.onClick as () => void)();
  expect(h.invoke).not.toHaveBeenCalled();
  acknowledge();
  const stale = button(P.clearDataConfirm)!.props.onClick as () => void;
  h.running = true;
  stale();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(button(P.clearDataConfirm)!.props.disabled).toBe(true);
});
