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
  active: false,
  copying: false,
  unknownCopy: false,
  stateCursor: 0,
  refCursor: 0,
  refs: [] as { current: unknown }[],
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
  h.active = false;
  h.copying = false;
  h.unknownCopy = false;
  render();
  h.effects[0]();
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
