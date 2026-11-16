import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PNG_IMAGE_TEST_DATA } from "./image_fixtures.test-support";
import { MESSAGE_AUDIO_WAV_TEST_DATA } from "./message_audio_fixtures.test-support";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
const image = {
  type: "image",
  mimeType: "image/png",
  data: PNG_IMAGE_TEST_DATA,
};
const audio = {
  type: "audio",
  mimeType: "audio/wav",
  data: MESSAGE_AUDIO_WAV_TEST_DATA,
};
let saved: unknown;
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  saved = null;
  vi.stubGlobal("document", { hidden: true, hasFocus: () => false });
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "settings_get")
      return args.key === "conversationReadState.v1" ? saved : null;
    if (cmd === "settings_set") {
      if (args.key === "conversationReadState.v1")
        saved = structuredClone(args.value);
      return null;
    }
    if (cmd === "desktop_notifications_get")
      return {
        enabled: false,
        successEnabled: false,
        sound: false,
        permission: "authorized",
        systemAlert: true,
        systemSound: false,
        clickRequiresRunning: true,
      };
    return [];
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const { threads } = await import("./sessions");
  const { conversationReadState: read, canMarkConversationRead } =
    await import("./conversation_read_state");
  await read.load();
  const s = threads.markOpenFailed(
    "fixture:/owned:sid",
    "fixture",
    "/owned",
    "sid",
    "Controlled",
  );
  s.openError = null;
  s.connectionId = "connection";
  read.setVisible("other-visible");
  const event = (e: unknown) =>
    (threads as any).applyChannelEvent(s.key, e, true);
  event({
    sessionId: "sid",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "page",
      status: "in_progress",
    },
  });
  return { read, s, event, canMarkConversationRead };
}
it.each([image, audio])(
  "background completed tool $type alone is readable and marks only its conversation",
  async (content) => {
    const f = await setup();
    f.event({
      sessionId: "sid",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "page",
        status: "completed",
        content: [{ type: "content", content }],
      },
    });
    const tool = f.s.items.find((i) => i.kind === "tool");
    expect(tool?.kind === "tool" && tool.call.content[0].type).toBe(
      "attachment",
    );
    await f.read.flush();
    expect(
      [...f.read.snapshot().unread],
      "normalized tool media exists but no new reply marker",
    ).toEqual([f.s.key]);
    expect(f.canMarkConversationRead(f.s)).toBe(true);
  },
);
it("background local verified toolMedia supplement alone marks its owner and can clear after readable open", async () => {
  const f = await setup();
  f.event({
    sessionId: "sid",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      status: "completed",
      rawOutput: { type: "success", content: [image] },
    },
  });
  f.event({
    kind: "toolMedia",
    sessionId: "sid",
    connectionId: "connection",
    toolCallId: "page",
    content: [image],
  });
  const tool = f.s.items.find((i) => i.kind === "tool");
  expect(
    tool?.kind === "tool" &&
      tool.call.content.some((c) => c.type === "attachment"),
  ).toBe(true);
  await f.read.flush();
  expect([...f.read.snapshot().unread]).toEqual([f.s.key]);
  expect(f.canMarkConversationRead(f.s)).toBe(true);
});
it("ordinary tool progress and textual result do not become unread replies", async () => {
  const f = await setup();
  f.event({
    sessionId: "sid",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Read operation completed" },
        },
      ],
    },
  });
  await f.read.flush();
  expect(f.read.snapshot().unread.size).toBe(0);
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "desktop_notification_submit"),
  ).toBe(false);
});

function completion(content: unknown, extra = {}) {
  return {
    sessionId: "sid",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      status: "completed",
      content: [{ type: "content", content }],
      ...extra,
    },
  };
}
function wrappedCompletion() {
  return {
    sessionId: "sid",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Result wrapper" } },
      ],
      rawOutput: { type: "success", content: [image] },
    },
  };
}
function hint() {
  return {
    kind: "toolMedia",
    sessionId: "sid",
    connectionId: "connection",
    toolCallId: "page",
    content: [image],
  };
}
async function openAndLeave(f: Awaited<ReturnType<typeof setup>>) {
  expect(f.canMarkConversationRead(f.s)).toBe(true);
  f.read.setVisible(f.s.key, f.canMarkConversationRead(f.s));
  await f.read.flush();
  expect(f.read.snapshot().unread.size).toBe(0);
  f.read.setVisible("other-visible");
}
it.each([image, audio])(
  "opening $type-only tool result clears and repeated completion/status stay read",
  async (content) => {
    const f = await setup();
    f.event(completion(content));
    await openAndLeave(f);
    f.event(completion(content));
    f.event({
      sessionId: "sid",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "page",
        status: "completed",
      },
    });
    await f.read.flush();
    expect(f.read.snapshot().unread.size).toBe(0);
    expect(saved).toEqual({ version: 1, unread: [] });
    vi.resetModules();
    const { conversationReadState: reloaded } =
      await import("./conversation_read_state");
    await reloaded.load();
    expect(reloaded.snapshot().unread.size).toBe(0);
  },
);
it("same raw completion and adjacent verified supplement do not resurrect already-read media", async () => {
  const f = await setup();
  f.event(wrappedCompletion());
  f.event(hint());
  await openAndLeave(f);
  f.event(wrappedCompletion());
  f.event(hint());
  await f.read.flush();
  expect(f.read.snapshot().unread.size).toBe(0);
  expect(
    f.s.items
      .filter((i) => i.kind === "tool")
      .flatMap((i) =>
        i.kind === "tool"
          ? i.call.content.filter((c) => c.type === "attachment")
          : [],
      ),
  ).toHaveLength(1);
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "desktop_notification_submit"),
  ).toBe(false);
});
it("standard content followed by the same supplement does not re-mark when opened between the adjacent deliveries", async () => {
  const f = await setup();
  f.event(completion(image));
  await openAndLeave(f);
  f.event(hint());
  await f.read.flush();
  expect(f.read.snapshot().unread.size).toBe(0);
});
it.each([image, audio])(
  "visible $type-only tool content does not create a new unread bit",
  async (content) => {
    const f = await setup();
    f.read.setVisible(f.s.key);
    f.event(completion(content));
    await f.read.flush();
    expect(f.read.snapshot().unread.size).toBe(0);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "settings_set")).toBe(
      false,
    );
  },
);
it("explicit replacement of an already-read image with different media marks unread; clearing alone does not", async () => {
  const f = await setup();
  f.event(completion(image));
  await openAndLeave(f);
  f.event(completion(audio));
  await f.read.flush();
  expect([...f.read.snapshot().unread]).toEqual([f.s.key]);
  await openAndLeave(f);
  f.event({
    sessionId: "sid",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      content: [],
    },
  });
  await f.read.flush();
  expect(f.read.snapshot().unread.size).toBe(0);
  expect(f.canMarkConversationRead(f.s)).toBe(false);
});
it.each(["session", "connection", "retired"])(
  "wrong %s owner cannot mark normalized media as unread",
  async (mismatch) => {
    const f = await setup();
    const { applySessionEvent } = await import("./session_event_projection");
    const e = completion(image);
    if (mismatch === "session") e.sessionId = "other-session";
    applySessionEvent(
      f.s,
      e,
      true,
      {
        owns: () => mismatch !== "retired",
        emit: vi.fn(),
        finishActivity: vi.fn(),
      } as any,
      mismatch === "connection" ? "other-connection" : f.s.connectionId,
    );
    await f.read.flush();
    expect(f.read.snapshot().unread.size).toBe(0);
  },
);
it("a forged supplement or rejected image cannot create a readable result or unread bit", async () => {
  const f = await setup();
  f.event(hint());
  f.event(
    completion({ type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" }),
  );
  await f.read.flush();
  expect(f.read.snapshot().unread.size).toBe(0);
  expect(f.canMarkConversationRead(f.s)).toBe(false);
});
it.each([false, true])(
  "real SessionOpenReplay tool-media history remains silent; preexisting unread=%s is preserved until readable open",
  async (existingUnread) => {
    const key = "fixture:/owned:sid";
    saved = { version: 1, unread: existingUnread ? [key] : [] };
    const normal = invoke.getMockImplementation()!;
    const { emitOpeningHeader } = await import("./session_open_test_fixture");
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd !== "session_open") return normal(cmd, args);
      const result = {
        cwd: "/owned",
        nativeSessionId: "sid",
        connectionId: "connection",
        resumed: true,
      };
      emitOpeningHeader(args, result);
      args.channel.onmessage({
        sessionId: "sid",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Please show the public page" },
        },
      });
      args.channel.onmessage(wrappedCompletion());
      args.channel.onmessage(hint());
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return result;
    });
    const { threads } = await import("./sessions");
    const { conversationReadState: read, canMarkConversationRead } =
      await import("./conversation_read_state");
    await read.load();
    const s = await threads.open({
      agentId: "fixture",
      cwd: "/owned",
      nativeSessionId: "sid",
    });
    expect(s.openError).toBeNull();
    expect(canMarkConversationRead(s)).toBe(true);
    expect([...read.snapshot().unread]).toEqual(existingUnread ? [key] : []);
    expect(
      invoke.mock.calls.some(([cmd]) => cmd === "desktop_notification_submit"),
    ).toBe(false);
    read.setVisible(s.key, canMarkConversationRead(s));
    await read.flush();
    expect(read.snapshot().unread.size).toBe(0);
  },
);
