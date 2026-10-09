import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  ref: 0,
  invoke: vi.fn(),
  open: vi.fn(),
  block: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (i >= h.states.length) h.states.push(initial);
    return [
      h.states[i],
      (v: unknown) =>
        (h.states[i] = typeof v === "function" ? v(h.states[i]) : v),
    ];
  },
  useRef: (current: unknown) => (h.refs[h.ref++] ??= { current }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open }));
import { StorageDatabaseRestore } from "./StorageDatabaseRestore";
import {
  DATABASE_RESTORE as S,
  type DatabaseStatus,
} from "../runtime/storage_database_restore";
const id = "a".repeat(48);
const preview = {
  id,
  sourcePath: "/private/candidate.sqlite3",
  counts: { agents: 2, sessions: 3, settings: 4, dismissedSessions: 1 },
};
const receipt: DatabaseStatus = {
  id,
  phase: "installed",
  protectedPath: "/private/protected",
  retainedPath: "/private/original",
  canContinue: false,
  canRestart: true,
};
let initialStatus: DatabaseStatus | null = null;
function render() {
  h.cursor = 0;
  h.ref = 0;
  return StorageDatabaseRestore({
    initialStatus,
    disabled: false,
    onBlockChange: h.block,
  });
}
function nodes(
  node: ReactNode = render(),
): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap((n) => nodes(n ?? null));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [
    { type: node.type, props: node.props },
    ...nodes((node.props.children ?? null) as ReactNode),
  ];
}
const flush = () => new Promise((r) => setTimeout(r, 0));
async function click(label: string) {
  const b = nodes().find(
    (n) => n.type === "button" && n.props.children === label,
  );
  expect(b).toBeDefined();
  expect(b!.props.disabled).not.toBe(true);
  (b!.props.onClick as () => void)();
  await flush();
}
async function choose() {
  h.open.mockResolvedValueOnce(preview.sourcePath);
  h.invoke.mockResolvedValueOnce(preview);
  await click(S.choose);
}
function confirm() {
  const input = nodes().find((n) => n.type === "input");
  (input!.props.onChange as (e: unknown) => void)({
    target: { checked: true },
  });
}
const visible = (text: string) =>
  nodes().some((n) => n.props.children === text);
beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.invoke.mockReset();
  h.open.mockReset();
  h.block.mockReset();
  initialStatus = null;
});
it("requires explicit confirmation and a separate restart without sending requests", async () => {
  await choose();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(
    nodes().find((n) => n.props.children === S.confirm)?.props.disabled,
  ).toBe(true);
  confirm();
  h.invoke.mockResolvedValueOnce(receipt);
  await click(S.confirm);
  expect(visible(S.installed)).toBe(true);
  expect(h.invoke).toHaveBeenCalledTimes(2);
  h.invoke.mockResolvedValueOnce(undefined);
  await click(S.restart);
  expect(h.invoke.mock.calls.map((c) => c[0])).toEqual([
    "storage_recovery_database_preview",
    "storage_recovery_database_apply",
    "storage_recovery_database_restart",
  ]);
  expect(h.block).not.toHaveBeenCalledWith(false);
});
it("a cancelled file chooser does not admit restoration", async () => {
  h.open.mockResolvedValueOnce(null);
  await click(S.choose);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.block).not.toHaveBeenCalled();
});
it("unknown apply only checks the ticket and never repeats replacement", async () => {
  await choose();
  confirm();
  h.invoke.mockRejectedValueOnce({
    code: "unknown",
    materialsPath: "/partial",
  });
  await click(S.confirm);
  expect(visible(S.confirm)).toBe(false);
  expect(visible(S.cancel)).toBe(false);
  expect(visible("/partial")).toBe(true);
  h.invoke.mockResolvedValueOnce(receipt);
  await click(S.check);
  expect(visible(S.installed)).toBe(true);
  expect(
    h.invoke.mock.calls.filter(
      (c) => c[0] === "storage_recovery_database_apply",
    ),
  ).toHaveLength(1);
});
it("a different ticket cannot become a success receipt", async () => {
  await choose();
  confirm();
  h.invoke.mockResolvedValueOnce({ ...receipt, id: "b".repeat(48) });
  await click(S.confirm);
  expect(visible(S.installed)).toBe(false);
  expect(visible(S.check)).toBe(true);
});
it("old released receipt after failed preparation permits only acknowledged cancellation", async () => {
  await choose();
  confirm();
  h.invoke.mockRejectedValueOnce({ code: "storage" });
  await click(S.confirm);
  h.invoke.mockResolvedValueOnce({
    ...receipt,
    id: "b".repeat(48),
    phase: "released",
    canRestart: false,
  });
  await click(S.check);
  expect(visible(S.noReceipt)).toBe(true);
  expect(visible(S.installed)).toBe(false);
  h.invoke.mockRejectedValueOnce("unknown");
  await click(S.cancel);
  expect(h.block).not.toHaveBeenCalledWith(false);
  h.invoke.mockResolvedValueOnce(undefined);
  await click(S.cancel);
  expect(h.block).toHaveBeenLastCalledWith(false);
});
it("persisted pending replacement waits for an explicit continue", async () => {
  initialStatus = {
    ...receipt,
    phase: "pending",
    canContinue: true,
    canRestart: false,
  };
  render();
  expect(h.invoke).not.toHaveBeenCalled();
  h.invoke.mockResolvedValueOnce(receipt);
  await click(S.continue);
  expect(visible(S.installed)).toBe(true);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
it("a malformed persisted status only permits inspection", async () => {
  initialStatus = { ...receipt, id: "invalid" };
  render();
  expect(visible(S.blocked)).toBe(true);
  expect(visible(S.choose)).toBe(false);
  expect(visible(S.restart)).toBe(false);
});
it("restart acknowledgement keeps the in-flight guard against stale callbacks", async () => {
  initialStatus = receipt;
  const button = nodes().find((n) => n.props.children === S.restart)!;
  h.invoke.mockResolvedValue(undefined);
  (button.props.onClick as () => void)();
  await flush();
  (button.props.onClick as () => void)();
  await flush();
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("interrupted preparation permits explicit reselection while cancellation keeps recovery closed", async () => {
  initialStatus = {
    ...receipt,
    phase: "preparing",
    canRestart: false,
    protectedPath: null,
  };
  expect(visible(S.preparing)).toBe(true);
  expect(visible(S.choose)).toBe(true);
  await choose();
  h.invoke.mockResolvedValueOnce(undefined);
  await click(S.cancel);
  expect(visible(S.preparing)).toBe(true);
  expect(h.block).not.toHaveBeenCalledWith(false);
});
it("failed reselection can return to the same prior preparing ticket without accepting another active replacement", async () => {
  initialStatus = {
    ...receipt,
    id: "b".repeat(48),
    phase: "preparing",
    canRestart: false,
    protectedPath: null,
  };
  await choose();
  confirm();
  h.invoke.mockRejectedValueOnce({ code: "storage" });
  await click(S.confirm);
  h.invoke.mockResolvedValueOnce(initialStatus);
  await click(S.check);
  expect(visible(S.preparing)).toBe(true);
  expect(visible(S.choose)).toBe(true);
  expect(visible(S.installed)).toBe(false);
});
it("a different pending operation never becomes an accepted status for the selection", async () => {
  await choose();
  confirm();
  h.invoke.mockRejectedValueOnce({ code: "unknown" });
  await click(S.confirm);
  h.invoke.mockResolvedValueOnce({
    ...receipt,
    id: "b".repeat(48),
    phase: "pending",
    canContinue: true,
    canRestart: false,
  });
  await click(S.check);
  expect(visible(S.continue)).toBe(false);
  expect(visible(S.check)).toBe(true);
});
