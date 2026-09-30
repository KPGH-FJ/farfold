import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  listeners: new Map<string, (event: { payload: number }) => void>(),
  effects: [] as (() => unknown)[],
  invoke: vi.fn(),
  flush: vi.fn(),
  setupFlush: vi.fn(),
  readFlush: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = h.states.push(initial) - 1;
    return [initial, (value: unknown) => (h.states[index] = value)];
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
  threads: { pauseQueuesForExit: vi.fn() },
}));
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
  h.effects.length = 0;
  h.listeners.clear();
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.flush.mockReset();
  h.setupFlush.mockReset().mockResolvedValue(undefined);
  h.readFlush.mockReset().mockResolvedValue(undefined);
  h.lock.mockReset();
  DraftStartup({ children: "editable" });
  h.effects[0]();
  await vi.waitFor(() =>
    expect(h.listeners.has("app:exit-deferred")).toBe(true),
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
  expect(h.lock).not.toHaveBeenCalled();
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
  expect(h.lock).not.toHaveBeenCalled();
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
