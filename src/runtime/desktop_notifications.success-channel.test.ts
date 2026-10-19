import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { draftPersistence } from "./drafts";
import { archiveActivity } from "./archive_activity";

type PromptArgs = {
  sessionId: string;
  promptToken: string;
  admissionChannel: { onmessage(value: unknown): void };
};
function receipt(args: PromptArgs) {
  return (
    invoke.mock.calls.findIndex(
      ([command, value]) => command === "session_prompt" && value === args,
    ) + 1
  );
}
function offer(args: PromptArgs, phase = "offered") {
  args.admissionChannel.onmessage({ receiptId: receipt(args), phase });
}
function ending(sessionId: string, value: unknown) {
  if (!value || typeof value !== "object") return value;
  const e = value as Record<string, unknown>;
  if (
    e.kind !== "turnEnd" ||
    Object.hasOwn(e, "update") ||
    Object.hasOwn(e, "sessionId")
  )
    return value;
  const args = [...invoke.mock.calls]
    .reverse()
    .find(
      ([command, args]) =>
        command === "session_prompt" && args.sessionId === sessionId,
    )?.[1] as PromptArgs | undefined;
  return args ? { ...e, promptReceiptId: receipt(args) } : value;
}

let serial = 0;
const channel = threads as unknown as {
  applyChannelEvent(key: string, event: unknown, live?: boolean): void;
};
const tick = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.stubGlobal("document", { hidden: true, hasFocus: () => false });
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_prompt") {
      offer(args);
      return { status: "accepted" };
    }
    if (command === "desktop_notifications_get")
      return {
        enabled: false,
        successEnabled: true,
        sound: false,
        permission: "authorized",
        systemAlert: true,
        systemSound: true,
        clickRequiresRunning: false,
      };
    if (command === "desktop_notification_submit") return "submitted";
    return command === "settings_get" ? null : [];
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  invoke.mockReset();
});
function setup() {
  const id = `success-${++serial}`;
  const s = threads.markOpenFailed(
    id,
    "fixture",
    "/controlled",
    id,
    "Private title",
  );
  s.openError = null;
  s.connectionId = `connection-${serial}`;
  s.configCheck = { status: "ready", issues: [], current: { choices: [] } };
  const event = (e: unknown, live = true) =>
    channel.applyChannelEvent(
      s.key,
      live ? ending(s.nativeSessionId, e) : e,
      live,
    );
  const reply = () =>
    event({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Private result" },
      },
    });
  const submissions = () =>
    invoke.mock.calls.filter(
      ([command]) => command === "desktop_notification_submit",
    );
  return { s, event, reply, submissions };
}
it("real send admission and projected successful ending submit once with only the existing target", async () => {
  const f = setup();
  expect(
    await threads.send(f.s.key, [{ type: "text", text: "Request" }]),
  ).toEqual({ status: "accepted" });
  f.reply();
  f.event({ kind: "turnEnd", stopReason: "end_turn" });
  await tick();
  expect(f.submissions()).toHaveLength(1);
  expect(f.submissions()[0][1]).toMatchObject({
    kind: "success",
    targetKey: f.s.key,
  });
  expect(JSON.stringify(f.submissions())).not.toMatch(
    /Private|controlled|Request/,
  );
  f.event({ kind: "turnEnd", stopReason: "end_turn" });
  await tick();
  expect(f.submissions()).toHaveLength(1);
});
it("real tool tail holds success until both completion and the actual live activity update", async () => {
  const f = setup();
  await threads.send(f.s.key, [{ type: "text", text: "Request" }]);
  f.reply();
  f.event({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "t",
      kind: "execute",
      status: "in_progress",
    },
  });
  f.event({ kind: "toolActivity", toolCallIds: ["t"] });
  f.event({ kind: "turnEnd", stopReason: "end_turn" });
  await tick();
  expect(f.submissions()).toHaveLength(0);
  f.event({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
    },
  });
  await tick();
  expect(f.submissions()).toHaveLength(0);
  f.event({ kind: "toolActivity", toolCallIds: [] });
  await tick();
  expect(f.submissions()).toHaveLength(1);
});
it.each(["cancelled", "history", "failed-tool"])(
  "production %s cannot produce a success",
  async (mode) => {
    const f = setup();
    await threads.send(f.s.key, [{ type: "text", text: "Request" }]);
    f.reply();
    if (mode === "failed-tool")
      f.event({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t",
          kind: "execute",
          status: "failed",
        },
      });
    f.event(
      {
        kind: "turnEnd",
        stopReason: mode === "cancelled" ? "cancelled" : "end_turn",
      },
      mode !== "history",
    );
    await tick();
    expect(f.submissions()).toHaveLength(0);
  },
);
it("a valid ending that arrives before admission acknowledgement waits for the send path to settle", async () => {
  const f = setup();
  let resolve!: (v: unknown) => void;
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, ...args: unknown[]) =>
    command === "session_prompt"
      ? new Promise((r) => {
          offer(args[0] as PromptArgs);
          resolve = r;
        })
      : normal(command, ...args),
  );
  const sending = threads.send(f.s.key, [{ type: "text", text: "Request" }]);
  await tick();
  f.reply();
  f.event({ kind: "turnEnd", stopReason: "end_turn" });
  await tick();
  expect(f.submissions()).toHaveLength(0);
  resolve({ status: "accepted" });
  await sending;
  await tick();
  expect(f.submissions()).toHaveLength(1);
});

it.each(["next-send", "connection-lost", "close"])(
  "withdraws the exact in-flight success on %s without claiming an already dispatched notice was unseen",
  async (change) => {
    const f = setup();
    let release!: (value: unknown) => void;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === "desktop_notification_submit")
        return new Promise((resolve) => {
          release = resolve;
        });
      if (command === "desktop_notification_withdraw")
        return Promise.resolve({ state: "alreadySubmitted" });
      return normal(command, ...args);
    });
    await threads.send(f.s.key, [{ type: "text", text: "First" }]);
    f.reply();
    f.event({ kind: "turnEnd", stopReason: "end_turn" });
    await tick();
    expect(f.submissions()).toHaveLength(1);
    const attempt = f.submissions()[0][1] as {
      rendererNonce: string;
      sequence: number;
    };
    if (change === "next-send")
      await threads.send(f.s.key, [{ type: "text", text: "Second" }]);
    else if (change === "connection-lost")
      f.event({ kind: "connectionLost", closeReason: "unexpected" });
    else await threads.close(f.s.key);
    await tick();
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "desktop_notification_withdraw",
      ),
    ).toEqual([
      [
        "desktop_notification_withdraw",
        { rendererNonce: attempt.rendererNonce, sequence: attempt.sequence },
      ],
    ]);
    release("submitted");
    await tick();
    expect(f.submissions()).toHaveLength(1);
  },
);
