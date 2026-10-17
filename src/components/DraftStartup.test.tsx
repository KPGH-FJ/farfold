import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  listeners: new Map<string, (event: { payload: number }) => void>(),
  effects: [] as (() => unknown)[],
  invoke: vi.fn(),
  flush: vi.fn(),
  setupFlush: vi.fn(),
  readFlush: vi.fn(),
  lock: vi.fn(),
  acquireLock: vi.fn(),
  active: false,
  copying: false,
  unknownCopy: false,
  stateCursor: 0,
  refCursor: 0,
  refs: [] as { current: unknown }[],
  cleanup: () => {},
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useRef: (current: unknown) => (h.refs[h.refCursor++] ??= { current }),
  useState: (initial: unknown) => {
    const index = h.stateCursor++;
    if (index >= h.states.length) h.states.push(initial);
    return [h.states[index], (value: unknown) => (h.states[index] = value)];
  },
  useEffect: (effect: () => unknown) => h.effects.push(effect),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    callback: (event: { payload: number }) => void,
  ) => {
    h.listeners.set(name, callback);
    return () => h.listeners.delete(name);
  },
}));
vi.mock("../runtime/drafts", () => ({
  draftPersistence: {
    load: async () => undefined,
    flush: h.flush,
    lockInteraction: h.lock,
    acquireInteractionLock: h.acquireLock,
  },
}));
vi.mock("../runtime/draft_storage", () => ({
  DRAFT_STRINGS: {},
  useDraftSaveStatus: () => ({ ready: true, error: null }),
}));
vi.mock("../runtime/sessions", () => ({
  threads: {
    pauseQueuesForExit: vi.fn(),
    getSnapshot: () => ({
      threads: new Map(h.active ? [["a", { running: true }]] : []),
    }),
  },
}));
vi.mock("../runtime/authentication", () => ({
  hasActiveAuthentication: () => false,
}));
vi.mock("../runtime/file_copy_jobs", () => ({
  hasUnsettledFileCopies: () => h.copying,
  fileCopyJobs: {
    getSnapshot: () =>
      h.unknownCopy
        ? [{ phase: "uncertain", status: { state: "unknown", settled: true } }]
        : [],
  },
  useFileCopyJobs: () => [],
}));
vi.mock("./FileCopyJobsStatus", () => ({ FileCopyJobsStatus: () => null }));
vi.mock("../runtime/update_impact", () => ({
  updateConversationBlocker: (thread: { running: boolean }) =>
    thread.running ? "仍在执行" : null,
}));
vi.mock("./WorkspaceDialog", () => ({ WorkspaceDialog: () => null }));
vi.mock("../runtime/setup_storage", () => ({
  setupStorage: { load: async () => undefined, flush: h.setupFlush },
  useSetupStorage: () => ({ ready: true, error: null }),
  SETUP_STORAGE_STRINGS: {},
}));
vi.mock("../runtime/conversation_read_state", () => ({
  conversationReadState: {
    flushPending: h.readFlush,
    snapshot: () => ({ error: "新回复状态尚未保存，请重试。" }),
  },
}));
import { DraftStartup } from "./DraftStartup";
import { WorktreeManagementHost } from "./WorktreeManagementHost";
import { EXIT_IMPACT } from "../runtime/exit_impact";

function render() {
  h.stateCursor = 0;
  h.refCursor = 0;
  return DraftStartup({ children: "editable" });
}
function click(text: string) {
  const find = (node: ReactNode): (() => void) | undefined => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node))
      return;
    if (node.type === "button" && node.props.children === text)
      return node.props.onClick;
    return find(node.props.children);
  };
  const callback = find(render());
  expect(callback).toBeDefined();
  callback!();
}

function nodes(node: ReactNode): ReactNode[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [node];
  return [node, ...nodes(node.props.children)];
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  h.states.length = 0;
  h.refs.length = 0;
  h.effects.length = 0;
  h.listeners.clear();
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.flush.mockReset();
  h.setupFlush.mockReset().mockResolvedValue(undefined);
  h.readFlush.mockReset().mockResolvedValue(undefined);
  h.lock.mockReset();
  h.acquireLock.mockReset().mockImplementation(() => {
    h.lock(true);
    return () => h.lock(false);
  });
  h.active = false;
  h.copying = false;
  h.unknownCopy = false;
  render();
  h.cleanup = h.effects[0]() as () => void;
  await vi.waitFor(() =>
    expect(h.listeners.has("app:exit-deferred")).toBe(true),
  );
});

it("keeps the worktree manager outside the locked editable subtree during quit", () => {
  h.copying = true;
  h.listeners.get("app:save-before-exit")!({ payload: 93 });
  const children = (render().props as { children: ReactNode[] }).children;
  expect(
    children.some(
      (n) => isValidElement(n) && n.type === WorktreeManagementHost,
    ),
  ).toBe(true);
  const editable = children.find(
    (n) =>
      isValidElement<{ inert?: boolean; children?: ReactNode }>(n) &&
      n.props.children === "editable",
  );
  expect(
    isValidElement<{ inert?: boolean }>(editable) && editable.props.inert,
  ).toBe(true);
});

it("does not let confirmation or restart interrupt an unsettled file save", async () => {
  h.copying = true;
  h.listeners.get("app:save-before-exit")!({ payload: 70 });
  click(EXIT_IMPACT.exit);
  h.listeners.get("app:save-before-restart")!({ payload: 71 });
  await Promise.resolve();
  expect(h.flush).not.toHaveBeenCalled();
  expect(
    h.invoke.mock.calls.some(([name]) => name === "app_exit_after_save"),
  ).toBe(false);
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
});

it("rechecks file saves after metadata flush before acknowledging exit", async () => {
  const saving = deferred();
  h.flush.mockReturnValueOnce(saving.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 72 });
  h.copying = true;
  saving.resolve();
  await vi.waitFor(() => expect(h.readFlush).toHaveBeenCalled());
  await Promise.resolve();
  expect(
    h.invoke.mock.calls.some(([name]) => name === "app_exit_after_save"),
  ).toBe(false);
  h.copying = false;
  click(EXIT_IMPACT.exit);
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", {
      token: 72,
      confirmActivity: true,
    }),
  );
});

it("keeps backend-only file activity in a cancellable exit review", async () => {
  h.invoke.mockImplementation((name) =>
    name === "app_exit_after_save"
      ? Promise.reject("FILE_COPY_EXIT_BLOCKED")
      : undefined,
  );
  h.listeners.get("app:save-before-exit")!({ payload: 73 });
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 73 }),
  );
  await Promise.resolve();
  expect(h.lock).not.toHaveBeenCalledWith(false);
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_cancel", { token: 73 }),
  );
});

it("keeps running worktree operations protected with their own exit explanation", async () => {
  h.invoke.mockImplementation((name) =>
    name === "app_exit_after_save"
      ? Promise.reject("WORKTREE_EXIT_BLOCKED")
      : undefined,
  );
  h.listeners.get("app:save-before-exit")!({ payload: 75 });
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 75 }),
  );
  await Promise.resolve();
  const visit = (node: ReactNode): ReactNode[] => {
    if (Array.isArray(node)) return node.flatMap(visit);
    if (!isValidElement<{ children?: ReactNode }>(node)) return [node];
    return [node, ...visit(node.props.children)];
  };
  const nodes = visit(render());
  expect(nodes).toContain(
    "工作位置操作仍在进行，或尚未确认是否结束。请先留在应用查看结果，再尝试退出。",
  );
  const exit = nodes.find(
    (node) =>
      isValidElement<{ children?: ReactNode }>(node) &&
      node.type === "button" &&
      node.props.children === EXIT_IMPACT.exit,
  );
  expect(
    isValidElement<{ disabled?: boolean }>(exit) && exit.props.disabled,
  ).toBe(true);
  expect(h.lock).not.toHaveBeenCalledWith(false);
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_cancel", { token: 75 }),
  );
});

it("requires explicit confirmation for finished unknown copies, including restart", async () => {
  h.unknownCopy = true;
  h.listeners.get("app:save-before-restart")!({ payload: 74 });
  expect(h.flush).not.toHaveBeenCalled();
  click(EXIT_IMPACT.exit);
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", {
      token: 74,
      confirmActivity: true,
    }),
  );
});

it("does not acknowledge normal quit while known work is still running", async () => {
  h.active = true;
  h.listeners.get("app:save-before-exit")!({ payload: 50 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 50,
  });
  expect(h.flush).not.toHaveBeenCalled();
});

it("requires review when backend activity starts after the renderer save began", async () => {
  h.invoke.mockImplementation((name) =>
    name === "app_exit_after_save"
      ? Promise.reject("EXIT_CONFIRMATION_REQUIRED")
      : undefined,
  );
  h.listeners.get("app:save-before-exit")!({ payload: 51 });
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 51 }),
  );
  expect(h.states[1]).toBe(false);
  expect(h.states).toContain(51);
  expect(h.lock).not.toHaveBeenCalledWith(false);
});

it("only an explicit confirm saves and acknowledges active work", async () => {
  h.active = true;
  h.listeners.get("app:save-before-exit")!({ payload: 60 });
  expect(h.flush).not.toHaveBeenCalled();
  click(EXIT_IMPACT.exit);
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", {
      token: 60,
      confirmActivity: true,
    }),
  );
});

it("staying invalidates the save owner and a late flush cannot close the app", async () => {
  const oldSave = deferred();
  h.flush.mockReturnValueOnce(oldSave.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 61 });
  h.active = true;
  h.listeners.get("app:save-before-exit")!({ payload: 61 });
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_cancel", { token: 61 }),
  );
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
  oldSave.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.flush).toHaveBeenCalledTimes(1);
  expect(
    h.invoke.mock.calls.some(([name]) => name === "app_exit_after_save"),
  ).toBe(false);
});

it("an already installed restart uses its backend admission despite stale frontend work", async () => {
  h.active = true;
  h.listeners.get("app:save-before-restart")!({ payload: 62 });
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 62 }),
  );
});

it("keeps an unconfirmed cancel visible and permits an explicit retry", async () => {
  h.active = true;
  h.invoke.mockImplementation((name) =>
    name === "app_exit_cancel" ? Promise.reject("temporary") : undefined,
  );
  h.listeners.get("app:save-before-exit")!({ payload: 63 });
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() => expect(h.states[7]).toBe(true));
  expect(h.lock).not.toHaveBeenCalledWith(false);
  h.invoke.mockResolvedValue(undefined);
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
  expect(h.flush).not.toHaveBeenCalled();
});

it("single-flights repeated stay actions so a duplicate rejection cannot hide successful cancellation", async () => {
  h.active = true;
  const firstReply = deferred();
  let backendHasOwner = true;
  h.invoke.mockImplementation((name) => {
    if (name !== "app_exit_cancel") return;
    // The real backend consumes its unacknowledged token once. Its successful
    // reply can reach the renderer after a second click has already happened.
    if (!backendHasOwner) return Promise.reject("关闭请求已失效");
    backendHasOwner = false;
    return firstReply.promise;
  });
  h.listeners.get("app:save-before-exit")!({ payload: 64 });
  click(EXIT_IMPACT.stay);
  click(EXIT_IMPACT.stay);
  firstReply.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "app_exit_cancel"),
  ).toHaveLength(1);
  expect(h.lock).toHaveBeenCalledWith(false);
  expect(h.states[2]).toBe(null);
  expect(h.states[7]).toBe(false);
});

it("shows cancellable ordinary exit waiting while a save is pending and ignores its late success", async () => {
  const saving = deferred();
  h.flush.mockReturnValueOnce(saving.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 65 });
  expect(nodes(render())).toContain("正在保存更改并准备退出…");
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
  expect(h.flush).toHaveBeenCalledTimes(1);
  saving.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 65,
  });
  expect(h.states[2]).toBe(null);
});

it("keeps cancellation pending single-flight despite a repeated quit event and a completed save", async () => {
  const saving = deferred();
  const cancel = deferred();
  h.flush.mockReturnValueOnce(saving.promise);
  h.invoke.mockImplementation((name) =>
    name === "app_exit_cancel" ? cancel.promise : undefined,
  );
  h.listeners.get("app:save-before-exit")!({ payload: 66 });
  click(EXIT_IMPACT.stay);
  h.listeners.get("app:save-before-exit")!({ payload: 66 });
  click(EXIT_IMPACT.stay);
  saving.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(nodes(render())).toContain("正在确认取消退出…");
  const stay = nodes(render()).find(
    (node) =>
      isValidElement<{ children?: ReactNode }>(node) &&
      node.type === "button" &&
      node.props.children === EXIT_IMPACT.stay,
  );
  expect(
    isValidElement<{ disabled?: boolean }>(stay) && stay.props.disabled,
  ).toBe(true);
  expect(h.flush).toHaveBeenCalledTimes(1);
  expect(h.readFlush).not.toHaveBeenCalled();
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "app_exit_cancel"),
  ).toHaveLength(1);
  expect(h.lock).not.toHaveBeenCalledWith(false);
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 66,
  });
  cancel.resolve();
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
});

it("keeps a failed pending-save withdrawal visible and retries cancellation only on another action", async () => {
  const saving = deferred();
  h.flush.mockReturnValueOnce(saving.promise);
  h.invoke.mockImplementation((name) =>
    name === "app_exit_cancel" ? Promise.reject("temporary") : undefined,
  );
  h.listeners.get("app:save-before-exit")!({ payload: 67 });
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() =>
    expect(nodes(render())).toContain(EXIT_IMPACT.cancelFailed),
  );
  expect(h.lock).not.toHaveBeenCalledWith(false);
  saving.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 67,
  });
  expect(h.flush).toHaveBeenCalledTimes(1);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "app_exit_cancel"),
  ).toHaveLength(1);
  h.invoke.mockResolvedValue(undefined);
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "app_exit_cancel"),
  ).toHaveLength(2);
  expect(h.flush).toHaveBeenCalledTimes(1);
});

it("does not let an old cancellation reply release or erase a newer pending cancellation", async () => {
  const firstSave = deferred();
  const secondSave = deferred();
  const firstCancel = deferred();
  const secondCancel = deferred();
  h.flush
    .mockReturnValueOnce(firstSave.promise)
    .mockReturnValueOnce(secondSave.promise);
  h.invoke.mockImplementation((name, args: { token: number }) => {
    if (name === "app_exit_cancel")
      return args.token === 80 ? firstCancel.promise : secondCancel.promise;
  });
  h.listeners.get("app:save-before-exit")!({ payload: 80 });
  click(EXIT_IMPACT.stay);
  h.listeners.get("app:save-before-exit")!({ payload: 81 });
  click(EXIT_IMPACT.stay);
  firstCancel.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.lock).not.toHaveBeenCalledWith(false);
  expect(h.states[2]).toBe(81);
  expect(nodes(render())).toContain("正在确认取消退出…");
  click(EXIT_IMPACT.stay);
  expect(
    h.invoke.mock.calls.filter(
      ([name, args]) => name === "app_exit_cancel" && args.token === 81,
    ),
  ).toHaveLength(1);
  firstSave.resolve();
  secondSave.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(
    h.invoke.mock.calls.some(([name]) => name === "app_exit_after_save"),
  ).toBe(false);
  secondCancel.resolve();
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
});

it("does not display a rejected old cancellation or old save over a newer exit", async () => {
  const firstSave = deferred();
  const secondSave = deferred();
  const firstCancel = deferred();
  h.flush
    .mockReturnValueOnce(firstSave.promise)
    .mockReturnValueOnce(secondSave.promise);
  h.invoke.mockImplementation((name) =>
    name === "app_exit_cancel" ? firstCancel.promise : undefined,
  );
  h.listeners.get("app:save-before-exit")!({ payload: 82 });
  click(EXIT_IMPACT.stay);
  h.listeners.get("app:save-before-exit")!({ payload: 83 });
  firstCancel.reject(new Error("old withdrawal failed"));
  firstSave.reject(new Error("old save failed"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.states[2]).toBe(83);
  expect(h.states[1]).toBe(false);
  expect(h.states[7]).toBe(false);
  expect(h.lock).not.toHaveBeenCalledWith(false);
  secondSave.resolve();
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 83 }),
  );
});

it("can withdraw while unread metadata saves without treating its late error as a new exit failure", async () => {
  const read = deferred();
  h.readFlush.mockReturnValueOnce(read.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 84 });
  await vi.waitFor(() => expect(h.readFlush).toHaveBeenCalledTimes(1));
  expect(nodes(render())).toContain("正在保存更改并准备退出…");
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
  read.reject(new Error("late metadata failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.states[1]).toBe(false);
  expect(h.states[2]).toBe(null);
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 84,
  });
});

it("keeps cancellation unconfirmed if the final exit command may already have acknowledged", async () => {
  const ack = deferred();
  h.invoke.mockImplementation((name) => {
    if (name === "app_exit_after_save") return ack.promise;
    if (name === "app_exit_cancel") return Promise.reject("关闭请求已失效");
  });
  h.listeners.get("app:save-before-exit")!({ payload: 85 });
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 85 }),
  );
  click(EXIT_IMPACT.stay);
  await vi.waitFor(() =>
    expect(nodes(render())).toContain(EXIT_IMPACT.cancelFailed),
  );
  ack.resolve();
  await Promise.resolve();
  expect(h.lock).not.toHaveBeenCalledWith(false);
  expect(h.states[2]).toBe(85);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "app_exit_after_save"),
  ).toHaveLength(1);
  expect(h.flush).toHaveBeenCalledTimes(1);
});

it("does not add a stay action to an installed restart while its save is pending", async () => {
  const saving = deferred();
  h.flush.mockReturnValueOnce(saving.promise);
  h.listeners.get("app:save-before-restart")!({ payload: 86 });
  expect(nodes(render())).not.toContain(EXIT_IMPACT.stay);
  expect(nodes(render())).not.toContain("正在保存更改并准备退出…");
  expect(h.invoke.mock.calls.some(([name]) => name === "app_exit_cancel")).toBe(
    false,
  );
  saving.resolve();
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 86 }),
  );
});

it("releases the current exit lock when the backend defers exit without resuming or acknowledging", async () => {
  const saving = deferred();
  h.flush.mockReturnValueOnce(saving.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 87 });
  expect(h.lock).toHaveBeenCalledWith(true);
  h.listeners.get("app:exit-deferred")!({ payload: 87 });
  expect(h.states[2]).toBe(null);
  expect(h.lock).toHaveBeenCalledWith(false);
  saving.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 87,
  });
  expect(h.readFlush).not.toHaveBeenCalled();
});

it("reuses one exit lease across repeated saves and owner replacement without releasing it early", async () => {
  const first = deferred(),
    second = deferred(),
    third = deferred();
  h.flush
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 88 });
  h.listeners.get("app:save-before-exit")!({ payload: 88 });
  h.listeners.get("app:save-before-exit")!({ payload: 89 });
  expect(h.acquireLock).toHaveBeenCalledTimes(1);
  h.listeners.get("app:exit-deferred")!({ payload: 88 });
  expect(h.lock).not.toHaveBeenCalledWith(false);
  first.reject(new Error("old save"));
  second.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.lock).not.toHaveBeenCalledWith(false);
  expect(h.states[2]).toBe(89);
  h.listeners.get("app:exit-deferred")!({ payload: 89 });
  expect(h.lock.mock.calls.filter(([value]) => value === false)).toHaveLength(
    1,
  );
  third.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(
    h.invoke.mock.calls.some(([name]) => name === "app_exit_after_save"),
  ).toBe(false);
});

it.each(["cancel", "deferred", "unmount"] as const)(
  "%s releases the actual exit lease while preserving legacy update and worktree locks",
  async (ending) => {
    const { draftPersistence: p } = await vi.importActual<
      typeof import("../runtime/draft_storage")
    >("../runtime/draft_storage");
    p.lockInteraction(true);
    const releaseWorktree = p.acquireInteractionLock();
    h.acquireLock.mockImplementation(() => p.acquireInteractionLock());
    const saving = deferred();
    h.flush.mockReturnValueOnce(saving.promise);
    try {
      h.listeners.get("app:save-before-exit")!({ payload: 90 });
      expect(h.acquireLock).toHaveBeenCalledTimes(1);
      if (ending === "cancel") {
        click(EXIT_IMPACT.stay);
        await vi.waitFor(() => expect(h.states[2]).toBe(null));
      } else if (ending === "deferred") {
        h.listeners.get("app:exit-deferred")!({ payload: 90 });
      } else {
        h.cleanup();
      }
      expect(p.snapshot().interactionLocked).toBe(true);
      releaseWorktree();
      expect(p.snapshot().interactionLocked).toBe(true);
      p.lockInteraction(false);
      expect(p.snapshot().interactionLocked).toBe(false);
      saving.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
        token: 90,
      });
      expect(h.readFlush).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
      releaseWorktree();
      p.lockInteraction(false);
      saving.resolve();
    }
  },
);

it("unmount invalidates a pending cancellation and its late rejection without touching other locks", async () => {
  const saving = deferred(),
    cancel = deferred();
  h.flush.mockReturnValueOnce(saving.promise);
  h.invoke.mockImplementation((name) =>
    name === "app_exit_cancel" ? cancel.promise : undefined,
  );
  h.listeners.get("app:save-before-exit")!({ payload: 91 });
  click(EXIT_IMPACT.stay);
  h.cleanup();
  const states = [...h.states];
  expect(h.lock.mock.calls.filter(([value]) => value === false)).toHaveLength(
    1,
  );
  cancel.reject(new Error("late cancel"));
  saving.reject(new Error("late save"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.states).toEqual(states);
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 91,
  });
  expect(h.lock.mock.calls.filter(([value]) => value === false)).toHaveLength(
    1,
  );
});

it("ignores an old exit save failure while a newer restart is saving", async () => {
  const oldSave = deferred();
  const restartSave = deferred();
  h.flush
    .mockReturnValueOnce(oldSave.promise)
    .mockReturnValueOnce(restartSave.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 10 });
  h.listeners.get("app:save-before-exit")!({ payload: 11 });
  oldSave.reject(new Error("late disk failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.lock).not.toHaveBeenCalledWith(false);
  expect(h.states[1]).toBe(false);
  restartSave.resolve();
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 11 }),
  );
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 10,
  });
});

it("ignores a late command rejection and a deferred old exit after a new owner starts", async () => {
  const oldAck = deferred();
  const restartSave = deferred();
  h.invoke.mockImplementation((name) =>
    name === "app_exit_after_save" ? oldAck.promise : undefined,
  );
  h.flush
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(restartSave.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 20 });
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 20 }),
  );
  h.listeners.get("app:save-before-exit")!({ payload: 21 });
  oldAck.reject(new Error("installation owns the application"));
  h.listeners.get("app:exit-deferred")!({ payload: 20 });
  await Promise.resolve();
  await Promise.resolve();
  expect(h.lock).not.toHaveBeenCalledWith(false);
  expect(h.states[2]).toBe(21);
  h.listeners.get("app:exit-deferred")!({ payload: 21 });
  expect(h.states[2]).toBe(null);
  restartSave.resolve();
  await Promise.resolve();
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 21,
  });
});

it("keeps the app open when preparation cannot save and waits for it on explicit retry", async () => {
  h.setupFlush.mockRejectedValueOnce(new Error("disk full"));
  h.listeners.get("app:save-before-exit")!({ payload: 30 });
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 30,
  });
  expect(h.states[1]).toBe(true);
  const retry = deferred();
  h.setupFlush.mockReturnValueOnce(retry.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 31 });
  await Promise.resolve();
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 31,
  });
  retry.resolve();
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 31 }),
  );
  expect(h.flush).toHaveBeenCalledTimes(2);
});

it("waits for pending unread metadata, keeps its actual save error and retries before exit", async () => {
  const pending = deferred();
  h.readFlush.mockReturnValueOnce(pending.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 40 });
  await vi.waitFor(() => expect(h.readFlush).toHaveBeenCalledTimes(1));
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 40,
  });
  pending.reject(new Error("disk full"));
  await vi.waitFor(() => expect(h.lock).toHaveBeenCalledWith(false));
  expect(h.states[1]).toBe(true);
  expect(h.states).toContain("新回复状态尚未保存，请重试。");
  const retry = deferred();
  h.readFlush.mockReturnValueOnce(retry.promise);
  h.listeners.get("app:save-before-exit")!({ payload: 41 });
  await vi.waitFor(() => expect(h.readFlush).toHaveBeenCalledTimes(2));
  expect(h.invoke).not.toHaveBeenCalledWith("app_exit_after_save", {
    token: 41,
  });
  retry.resolve();
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", { token: 41 }),
  );
});
