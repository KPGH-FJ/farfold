import { beforeEach, expect, it, vi } from "vitest";
import type { ThreadItem } from "./session_types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const reply = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "Real reply" },
};
let saved: unknown;
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  saved = null;
  invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return saved;
    if (command === "settings_set") saved = structuredClone(args.value);
  });
});
const store = async () =>
  (await import("./conversation_read_state")).conversationReadState;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("persists a background reply, clears it on opening and retains that state after restart", async () => {
  let state = await store();
  await state.load();
  state.receiveUpdate("one", reply);
  state.receiveUpdate("one", reply);
  await state.flush();
  expect(saved).toEqual({ version: 1, unread: ["one"] });
  expect(
    invoke.mock.calls.filter(([cmd]) => cmd === "settings_set"),
  ).toHaveLength(1);
  vi.resetModules();
  state = await store();
  await state.load();
  expect(state.snapshot().unread.has("one")).toBe(true);
  state.setVisible("one");
  state.receiveUpdate("one", reply);
  await state.flush();
  expect(saved).toEqual({ version: 1, unread: [] });
  vi.resetModules();
  state = await store();
  await state.load();
  expect(state.snapshot().unread.size).toBe(0);
  state.setVisible(null);
  state.receiveUpdate("one", reply);
  await state.flush();
  expect(state.snapshot().unread.has("one")).toBe(true);
});

it("does not treat thought, tools, user echoes, empty or unknown content as new replies", async () => {
  const state = await store();
  await state.load();
  for (const update of [
    { ...reply, sessionUpdate: "agent_thought_chunk" },
    { ...reply, sessionUpdate: "user_message_chunk" },
    { ...reply, sessionUpdate: "tool_call_update" },
    { ...reply, content: { type: "text", text: "  " } },
    { ...reply, content: { type: "image", data: "", mimeType: "image/png" } },
    { ...reply, content: { type: "unknown" } },
  ])
    state.receiveUpdate("one", update);
  await state.flush();
  expect(state.snapshot().unread.size).toBe(0);
  expect(
    invoke.mock.calls.filter(([cmd]) => cmd === "settings_set"),
  ).toHaveLength(0);
  state.receiveUpdate("two", {
    ...reply,
    content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  });
  await state.flush();
  expect(state.snapshot().unread.has("two")).toBe(true);
});

it("a failed or empty history opening does not consume previously unread replies", async () => {
  saved = { version: 1, unread: ["one"] };
  const state = await store();
  await state.load();
  state.setVisible("one", false);
  expect(state.snapshot().unread.has("one")).toBe(true);
  state.receiveUpdate("one", reply);
  expect(state.snapshot().unread.has("one")).toBe(true);
  state.setVisible("one", true);
  await state.flush();
  expect(state.snapshot().unread.has("one")).toBe(false);
});

it("only successfully displayed Agent text or attachments can mark a conversation read", async () => {
  const { canMarkConversationRead } = await import("./conversation_read_state");
  const message: ThreadItem = {
    kind: "agent",
    id: "reply",
    text: "Reply",
    streaming: false,
    time: 0,
  };
  const thread = {
    items: [message],
    openError: null,
    reconnecting: false,
    unrecoverable: false,
  };
  expect(canMarkConversationRead(thread)).toBe(true);
  expect(
    canMarkConversationRead({
      ...thread,
      items: [{ ...message, kind: "user", attachments: [] }],
    }),
  ).toBe(false);
  expect(
    canMarkConversationRead({ ...thread, items: [{ ...message, text: " " }] }),
  ).toBe(false);
  expect(
    canMarkConversationRead({ ...thread, openError: "History unavailable" }),
  ).toBe(false);
  expect(canMarkConversationRead({ ...thread, reconnecting: true })).toBe(
    false,
  );
  expect(canMarkConversationRead({ ...thread, unrecoverable: true })).toBe(
    false,
  );
  expect(
    canMarkConversationRead({
      ...thread,
      items: [
        {
          ...message,
          text: "",
          attachments: [
            {
              kind: "image",
              name: "Image",
              mimeType: "image/png",
              data: "aW1hZ2U=",
            },
          ],
        },
      ],
    }),
  ).toBe(true);
});

it("merges replies and read actions observed while metadata is loading", async () => {
  const read = deferred<unknown>();
  invoke.mockImplementationOnce(() => read.promise);
  const state = await store();
  const loading = state.load();
  state.receiveUpdate("new", reply);
  state.setVisible("old");
  read.resolve({ version: 1, unread: ["old", "kept"] });
  await loading;
  await state.flush();
  expect([...state.snapshot().unread].sort()).toEqual(["kept", "new"]);
  expect(saved).toEqual({ version: 1, unread: ["kept", "new"] });
});

it("late writes never restore unread after opening or erase replies received after leaving", async () => {
  const write = deferred<void>();
  const started = deferred<void>();
  const state = await store();
  await state.load();
  invoke.mockImplementationOnce(async (_command, args) => {
    started.resolve();
    await write.promise;
    saved = args.value;
  });
  state.receiveUpdate("one", reply);
  await started.promise;
  state.setVisible("one");
  state.setVisible(null);
  state.receiveUpdate("two", reply);
  write.resolve();
  await state.flush();
  expect(saved).toEqual({ version: 1, unread: ["two"] });
  expect([...state.snapshot().unread]).toEqual(["two"]);
});

it("preserves failed saves for retry without claiming they were persisted", async () => {
  const state = await store();
  await state.load();
  invoke.mockRejectedValueOnce(new Error("disk full"));
  state.receiveUpdate("one", reply);
  await vi.waitFor(() => expect(state.snapshot().error).toBeTruthy());
  expect(saved).toBeNull();
  expect(state.snapshot().unread.has("one")).toBe(true);
  await state.flush();
  expect(saved).toEqual({ version: 1, unread: ["one"] });
  expect(state.snapshot().error).toBeNull();
});

it("does not overwrite invalid metadata with a made-up empty state", async () => {
  saved = { version: 2, unread: ["one"] };
  const state = await store();
  state.receiveUpdate("new", reply);
  await expect(state.flush()).rejects.toThrow();
  expect(state.snapshot().ready).toBe(false);
  expect(saved).toEqual({ version: 2, unread: ["one"] });
  expect(
    invoke.mock.calls.filter(([cmd]) => cmd === "settings_set"),
  ).toHaveLength(0);
});

it("does not block exit on an unrelated metadata read failure when nothing changed", async () => {
  saved = { version: 2, unread: ["one"] };
  const state = await store();
  await expect(state.load()).rejects.toThrow();
  await expect(state.flushPending()).resolves.toBeUndefined();
  expect(
    invoke.mock.calls.filter(([cmd]) => cmd === "settings_set"),
  ).toHaveLength(0);
});
