import { beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement } from "react";
const h = vi.hoisted(() => ({ state: { operationId: "op" } }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
vi.mock("../runtime/worktrees", () => ({
  worktrees: { subscribe: () => () => {}, snapshot: () => h.state },
}));
import { worktreeManagement } from "../runtime/worktree_management";
import { WorktreeManagementHost } from "./WorktreeManagementHost";
import { WorktreeDialog } from "./WorktreeDialog";
function controls() {
  const view = WorktreeManagementHost();
  const parts =
    view && typeof view.type === "symbol"
      ? Children.toArray(view.props.children)
      : [view];
  const get = (type: unknown) =>
    parts.find(
      (part): part is ReactElement<Record<string, unknown>> =>
        isValidElement(part) && part.type === type,
    )!;
  return { entry: get("button"), dialog: get(WorktreeDialog) };
}
beforeEach(() => {
  const old = worktreeManagement.snapshot();
  if (old) worktreeManagement.close(old);
  h.state = { operationId: "op" };
});
it("a recovery entry cannot replace a newer manager through an old click", () => {
  const old = controls().entry;
  expect(old.type).toBe("button");
  const opened = worktreeManagement.open({
    cwd: "/new",
    target: { isCurrent: () => true, apply: async () => true },
  });
  (old.props.onClick as () => void)();
  expect(worktreeManagement.snapshot()).toBe(opened);
});
it("closing and reopening an operation has an independent owner and no draft application target", () => {
  const old = worktreeManagement.open({
    cwd: "/repo",
    target: { isCurrent: () => true, apply: async () => true },
  });
  const view = controls().dialog;
  expect(view.type).toBe(WorktreeDialog);
  (view.props.onClose as () => void)();
  (controls().entry.props.onClick as (event: unknown) => void)({
    currentTarget: {},
  });
  const reopened = worktreeManagement.snapshot()!;
  expect(reopened).not.toBe(old);
  expect(reopened.target).toBeNull();
  (view.props.onClose as () => void)();
  expect(worktreeManagement.snapshot()).toBe(reopened);
});

it("keeps the recovery entry mounted as the exact dialog focus return", () => {
  const opener = {};
  (controls().entry.props.onClick as (event: unknown) => void)({
    currentTarget: opener,
  });
  const { entry, dialog } = controls();
  expect(dialog.props.returnFocusRef).toEqual({ current: opener });
  expect(entry.type).toBe("button");
  (dialog.props.onClose as () => void)();
  expect(controls().entry.type).toBe("button");
});
