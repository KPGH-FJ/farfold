import { beforeEach, expect, it, vi } from "vitest";
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
beforeEach(() => {
  const old = worktreeManagement.snapshot();
  if (old) worktreeManagement.close(old);
  h.state = { operationId: "op" };
});
it("a recovery entry cannot replace a newer manager through an old click", () => {
  const old = WorktreeManagementHost()!;
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
  const view = WorktreeManagementHost()!;
  expect(view.type).toBe(WorktreeDialog);
  (view.props.onClose as () => void)();
  (WorktreeManagementHost()!.props.onClick as () => void)();
  const reopened = worktreeManagement.snapshot()!;
  expect(reopened).not.toBe(old);
  expect(reopened.target).toBeNull();
  (view.props.onClose as () => void)();
  expect(worktreeManagement.snapshot()).toBe(reopened);
});
