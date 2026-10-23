import { emitOpeningHeader } from "./session_open_test_fixture";
import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
const reply = {
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Reply" },
  },
};
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
});

it("cold history and its ordered boundary remain read; later background channel replies become unread", async () => {
  let channel!: { onmessage: (event: unknown) => void };
  invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return null;
    if (command !== "session_open") return [];
    channel = args.channel;
    emitOpeningHeader(args, {
      cwd: "/p",
      nativeSessionId: "history",
      connectionId: "unread-history",
    });
    channel.onmessage(reply);
    channel.onmessage({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    return {
      cwd: "/p",
      nativeSessionId: "history",
      connectionId: "unread-history",
      resumed: true,
    };
  });
  const { threads } = await import("./sessions");
  const { conversationReadState: read } =
    await import("./conversation_read_state");
  await read.load();
  const state = await threads.open({
    agentId: "test",
    cwd: "/p",
    nativeSessionId: "history",
  });
  expect(state.items.some((item) => item.kind === "agent")).toBe(true);
  expect(read.snapshot().unread.size).toBe(0);
  channel.onmessage(reply);
  await read.flush();
  expect(read.snapshot().unread.has(state.key)).toBe(true);
  read.setVisible(state.key);
  await read.flush();
  channel.onmessage(reply);
  expect(read.snapshot().unread.has(state.key)).toBe(false);
  read.setVisible(null);
  channel.onmessage(reply);
  expect(read.snapshot().unread.has(state.key)).toBe(true);
  await read.flush();
});

it("history replay preserves persisted unread until readable content is actually opened", async () => {
  const key = "test:/p:persisted";
  invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get")
      return args.key === "conversationReadState.v1"
        ? { version: 1, unread: [key] }
        : null;
    if (command !== "session_open") return [];
    emitOpeningHeader(args, {
      cwd: "/p",
      nativeSessionId: "persisted",
      connectionId: "unread-persisted",
    });
    args.channel.onmessage(reply);
    args.channel.onmessage({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    return {
      cwd: "/p",
      nativeSessionId: "persisted",
      connectionId: "unread-persisted",
      resumed: true,
    };
  });
  const { threads } = await import("./sessions");
  const { conversationReadState: read } =
    await import("./conversation_read_state");
  await read.load();
  await threads.open({
    agentId: "test",
    cwd: "/p",
    nativeSessionId: "persisted",
  });
  expect(read.snapshot().unread.has(key)).toBe(true);
  read.setVisible(key);
  await read.flush();
  expect(read.snapshot().unread.has(key)).toBe(false);
});
