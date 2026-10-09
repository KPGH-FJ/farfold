import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  refCursor: 0,
  refs: [] as { current: unknown }[],
  effects: [] as (() => (() => void) | void)[],
  invoke: vi.fn(),
  open: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) =>
    (h.refs[h.refCursor++] ??= { current: initial }),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (index >= h.states.length) h.states.push(initial);
    return [
      h.states[index],
      (value: unknown) => {
        h.states[index] = value;
      },
    ];
  },
  useEffect: (effect: () => (() => void) | void) => {
    h.effects.push(effect);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open }));
import { StorageRecovery, StorageStartup } from "./StorageRecovery";
import { STRINGS } from "../runtime/strings";
const S = STRINGS.storageRecovery;
function renderStartup() {
  h.cursor = 0;
  h.refCursor = 0;
  return StorageStartup({ children: "editable application" });
}
function panel(onRetry = async () => {}) {
  h.cursor = 0;
  h.refCursor = 0;
  return StorageRecovery({ message: "fixture failure", onRetry });
}
function elements(
  node: ReactNode,
): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [
    node as { type: unknown; props: Record<string, unknown> },
    ...elements(node.props.children),
  ];
}
function text(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  return isValidElement<{ children?: ReactNode }>(node)
    ? text(node.props.children)
    : "";
}
function click(tree: ReactNode, label: string) {
  const button = elements(tree).find(
    (node) => node.type === "button" && node.props.children === label,
  );
  expect(button).toBeDefined();
  (button!.props.onClick as () => void)();
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  h.states = [];
  h.cursor = 0;
  h.effects = [];
  h.refs = [];
  h.refCursor = 0;
  h.invoke.mockReset();
  h.open.mockReset();
});

it("keeps editable children absent until the backend confirms readiness", async () => {
  h.invoke.mockResolvedValue({
    ready: false,
    issue: { kind: "corrupt" },
    dataDirectory: "/fixture",
  });
  expect(renderStartup()).not.toBe("editable application");
  h.effects[0]();
  await tick();
  const blocked = renderStartup();
  expect(isValidElement(blocked) && blocked.type).toBe(StorageRecovery);
  h.invoke.mockResolvedValue({
    ready: true,
    issue: null,
    dataDirectory: "/fixture",
  });
  if (!isValidElement<{ onRetry: () => Promise<void> }>(blocked))
    throw new Error("recovery expected");
  await blocked.props.onRetry();
  expect(renderStartup()).toBe("editable application");
  expect(h.invoke.mock.calls.map(([name]) => name)).toEqual([
    "storage_recovery_status",
    "storage_recovery_retry",
  ]);
});
it("does not mount an editable app after a lost startup receipt", async () => {
  h.invoke.mockRejectedValue(new Error("lost receipt"));
  renderStartup();
  h.effects[0]();
  await tick();
  expect(isValidElement(renderStartup())).toBe(true);
  expect(renderStartup()).not.toBe("editable application");
});
it("canceling the destination picker never exports or resets anything", async () => {
  h.open.mockResolvedValue(null);
  click(panel(), S.export);
  await tick();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(text(panel())).not.toContain(S.snapshotSaved);
});
it("acknowledges an unverified file copy distinctly and never invokes a write-to-settings command", async () => {
  h.open.mockResolvedValue("/chosen");
  h.invoke.mockResolvedValue({
    kind: "unverifiedFiles",
    path: "/chosen/recovery",
  });
  click(panel(), S.export);
  await tick();
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("storage_recovery_export", {
    directory: "/chosen",
  });
  expect(text(panel())).toContain(S.filesSaved);
  expect(text(panel())).not.toContain(S.snapshotSaved);
});
it("shows a failed export without a success receipt and permits explicit retry", async () => {
  h.open.mockResolvedValue("/chosen");
  h.invoke.mockRejectedValue("FARFOLD_STORAGE:full:fixture");
  click(panel(), S.export);
  await tick();
  expect(text(panel())).toContain(S.issues.full);
  expect(text(panel())).not.toContain(S.snapshotSaved);
  h.invoke.mockResolvedValue({ kind: "snapshot", path: "/chosen/copy" });
  click(panel(), S.export);
  await tick();
  expect(text(panel())).toContain(S.snapshotSaved);
});
it("blocks repeated actions while an export receipt is pending", async () => {
  h.open.mockResolvedValue("/chosen");
  let complete!: (value: unknown) => void;
  h.invoke.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  click(panel(), S.export);
  await tick();
  expect(
    elements(panel())
      .filter((n) => n.type === "button")
      .every((n) => n.props.disabled === true),
  ).toBe(true);
  complete({ kind: "snapshot", path: "/chosen/copy" });
  await tick();
  expect(
    elements(panel())
      .filter((n) => n.type === "button")
      .every((n) => n.props.disabled === false),
  ).toBe(true);
});

it("shows the incomplete-copy location and removes the previous successful receipt", async () => {
  h.open.mockResolvedValue("/chosen");
  h.invoke.mockResolvedValueOnce({
    kind: "snapshot",
    path: "/chosen/previous",
  });
  click(panel(), S.export);
  await tick();
  expect(text(panel())).toContain(S.snapshotSaved);
  h.invoke.mockRejectedValueOnce({
    issue: { kind: "full" },
    partialPath: "/chosen/incomplete",
  });
  click(panel(), S.export);
  await tick();
  const rendered = text(panel());
  expect(rendered).toContain(S.exportFull);
  expect(rendered).toContain(S.partialSaved);
  expect(rendered).toContain("/chosen/incomplete");
  expect(rendered).not.toContain(S.snapshotSaved);
  expect(rendered).not.toContain("/chosen/previous");
});
it("does not open two pickers when the same handler is activated before React rerenders", async () => {
  h.open.mockResolvedValue(null);
  const rendered = panel();
  click(rendered, S.export);
  click(rendered, S.export);
  await tick();
  expect(h.open).toHaveBeenCalledTimes(1);
});
