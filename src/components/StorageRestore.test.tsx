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
import { StorageRestore } from "./StorageRestore";
import { STORAGE_RESTORE_STRINGS as S } from "../runtime/storage_restore_strings";
const id = "a".repeat(48);
const preview = {
  id,
  sourcePath: "/private/candidate.sqlite3",
  values: { "unsentWork.v1": "null", "agentSetup.v1": "null" },
};
const receipt = {
  id,
  keys: ["unsentWork.v1"],
  protectedPath: "/private/protected",
};
function render() {
  h.cursor = 0;
  h.ref = 0;
  return StorageRestore({
    keys: ["unsentWork.v1", "agentSetup.v1"],
    disabled: false,
    onBlockChange: h.block,
  });
}
function nodes(
  node: ReactNode = render(),
): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap((n) => nodes(n));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [
    { type: node.type, props: node.props },
    ...nodes((node.props.children ?? null) as ReactNode),
  ];
}
async function click(label: string) {
  const button = nodes().find(
    (n) => n.type === "button" && n.props.children === label,
  );
  expect(button).toBeDefined();
  expect(button!.props.disabled).not.toBe(true);
  (button!.props.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
}
async function choose() {
  h.open.mockResolvedValueOnce("/private/candidate.sqlite3");
  h.invoke.mockResolvedValueOnce(preview);
  await click(S.choose);
}
function select() {
  const input = nodes().find((n) => n.type === "input");
  (input!.props.onChange as (e: unknown) => void)({
    target: { checked: true },
  });
}
beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.invoke.mockReset();
  h.open.mockReset();
  h.block.mockReset();
});
it("cancelled native selection does not block startup or request restoration", async () => {
  h.open.mockResolvedValueOnce(null);
  await click(S.choose);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.block).not.toHaveBeenCalled();
});
it("requires explicit selection and confirmation, then only reloads on a separate action", async () => {
  await choose();
  expect(h.block).toHaveBeenCalledWith(true);
  expect(h.invoke.mock.calls.map((c) => c[0])).toEqual([
    "storage_recovery_restore_preview",
  ]);
  expect(
    nodes().find((n) => n.props.children === S.confirm)?.props.disabled,
  ).toBe(true);
  select();
  h.open.mockResolvedValueOnce("/private/backups");
  h.invoke.mockResolvedValueOnce(receipt);
  await click(S.confirm);
  expect(h.invoke).toHaveBeenLastCalledWith("storage_recovery_restore_apply", {
    id,
    keys: ["unsentWork.v1"],
    backupDirectory: "/private/backups",
  });
  expect(nodes().some((n) => n.props.children === S.restored)).toBe(true);
  expect(nodes().some((n) => n.props.children === S.reloading)).toBe(true);
  expect(h.block).not.toHaveBeenCalledWith(false);
  expect(h.invoke).toHaveBeenCalledTimes(2);
});
it("an unknown apply result freezes editing and checks the ticket without applying twice", async () => {
  await choose();
  select();
  h.open.mockResolvedValueOnce("/private/backups");
  h.invoke.mockRejectedValueOnce("lost transport");
  await click(S.confirm);
  expect(nodes().some((n) => n.props.children === S.confirm)).toBe(false);
  expect(nodes().some((n) => n.props.children === S.cancel)).toBe(false);
  expect(nodes().find((n) => n.type === "fieldset")?.props.disabled).toBe(true);
  h.invoke.mockResolvedValueOnce(null);
  await click(S.check);
  expect(nodes().some((n) => n.props.children === S.noReceipt)).toBe(true);
  h.invoke.mockResolvedValueOnce(receipt);
  await click(S.check);
  expect(nodes().some((n) => n.props.children === S.restored)).toBe(true);
  expect(
    h.invoke.mock.calls.filter(
      (c) => c[0] === "storage_recovery_restore_apply",
    ),
  ).toHaveLength(1);
});
it("a mismatched successful receipt remains unknown rather than claiming recovery", async () => {
  await choose();
  select();
  h.open.mockResolvedValueOnce("/private/backups");
  h.invoke.mockResolvedValueOnce({ ...receipt, id: "other" });
  await click(S.confirm);
  expect(nodes().some((n) => n.props.children === S.restored)).toBe(false);
  expect(nodes().some((n) => n.props.children === S.check)).toBe(true);
});
it("a confirmed failed transaction identifies its protective copy and leaves selection editable", async () => {
  await choose();
  select();
  h.open.mockResolvedValueOnce("/private/backups");
  h.invoke.mockRejectedValueOnce({
    code: "storage",
    materialsPath: "/private/protected",
    materialsComplete: true,
  });
  await click(S.confirm);
  expect(nodes().some((n) => n.props.children === "/private/protected")).toBe(
    true,
  );
  expect(nodes().some((n) => n.props.children === S.materials)).toBe(true);
  expect(nodes().some((n) => n.props.children === S.restored)).toBe(false);
  expect(nodes().some((n) => n.props.children === S.confirm)).toBe(true);
});
it("cancels only with acknowledged backend release", async () => {
  await choose();
  h.invoke.mockRejectedValueOnce("lost");
  await click(S.cancel);
  expect(h.block).not.toHaveBeenCalledWith(false);
  h.invoke.mockResolvedValueOnce(undefined);
  await click(S.cancel);
  expect(h.block).toHaveBeenLastCalledWith(false);
  expect(nodes().some((n) => n.props.children === S.choose)).toBe(true);
});
