import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
beforeEach(() => {
  h.invoke.mockImplementation(async (cmd: string) =>
    cmd === "settings_get" ? 0 : [],
  );
});
afterEach(() => {
  vi.useRealTimers();
  h.invoke.mockReset();
});
function seed(id: string) {
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  return s;
}
function permission(key: string, id: string) {
  (
    threads as unknown as {
      applyChannelEvent: (key: string, event: unknown) => void;
    }
  ).applyChannelEvent(key, {
    kind: "permissionRequest",
    requestId: id,
    toolCall: { toolCallId: id, title: id },
    options: [{ optionId: "yes", kind: "allow_always", name: "allow" }],
  });
}
it("keeps both concurrent approvals", () => {
  const s = seed("two");
  permission(s.key, "p1");
  permission(s.key, "p2");
  expect(s.pendingPermissions.map((p) => p.requestId)).toEqual(["p1", "p2"]);
});
it("does not suppress a remembered decision when another request arrives", async () => {
  vi.useFakeTimers();
  h.invoke.mockResolvedValue(undefined);
  const s = seed("delay");
  permission(s.key, "p1");
  threads.decidePermission(s.key, "p1", "yes", "allow", true, true);
  permission(s.key, "p2");
  await vi.advanceTimersByTimeAsync(5001);
  expect(h.invoke).toHaveBeenCalledWith(
    "session_permission_respond",
    expect.objectContaining({ requestId: "p1" }),
  );
  expect(s.pendingPermissions.map((p) => p.requestId)).toEqual(["p2"]);
});
it("restored sessions are established and cannot change model", async () => {
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "m1",
      options: [{ value: "m1", name: "M1" }],
    },
  ];
  h.invoke.mockImplementation(async (cmd: string) =>
    cmd === "session_open"
      ? {
          cwd: "/p",
          nativeSessionId: "loaded",
          resumed: true,
          configOptions: options,
        }
      : cmd === "settings_get"
        ? 0
        : [],
  );
  const s = await threads.open({
    agentId: "a",
    cwd: "/p",
    nativeSessionId: "loaded",
  });
  expect(s.identity).toBe("established");
  await expect(threads.setConfig(s.key, "model", "m2")).rejects.toBeTruthy();
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_set_config"),
  ).toHaveLength(0);
});
it("retains content and a retryable error after failed reconnect", async () => {
  const s = seed("failed");
  s.connectionLost = true;
  s.title = "Keep me";
  h.invoke.mockRejectedValue(Error("synthetic load failure"));
  await threads.reconnect(s.key);
  expect(threads.thread(s.key)?.title).toBe("Keep me");
  expect(threads.thread(s.key)?.openError).toBeTruthy();
});
it("pauses rather than drops queued messages on failed completion", async () => {
  const s = seed("queue");
  s.running = true;
  s.queued = [[{ type: "text", text: "keep" }]];
  (
    threads as unknown as {
      applyChannelEvent: (key: string, event: unknown) => void;
    }
  ).applyChannelEvent(s.key, { kind: "turnEnd", error: "failed" });
  expect(s.queued).toHaveLength(1);
  expect(s.queuePaused).toBeTruthy();
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_prompt"),
  ).toHaveLength(0);
});
function event(key: string, value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent: (key: string, event: unknown) => void;
    }
  ).applyChannelEvent(key, value);
}
it("undo and duplicate clicks cannot submit a stale decision", async () => {
  vi.useFakeTimers();
  const s = seed("undo");
  permission(s.key, "p");
  threads.decidePermission(s.key, "p", "yes", "first", true, true);
  threads.decidePermission(s.key, "p", "yes", "duplicate", true, true);
  threads.undoPermissionDecision(s.key, "p");
  await vi.advanceTimersByTimeAsync(4000);
  threads.decidePermission(s.key, "p", "yes", "new", true, true);
  await vi.advanceTimersByTimeAsync(1001);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_permission_respond"),
  ).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(4000);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_permission_respond"),
  ).toHaveLength(1);
});
it("failed approval remains retryable and ended approvals cannot fire timers", async () => {
  vi.useFakeTimers();
  const s = seed("approval-fail");
  permission(s.key, "p");
  h.invoke.mockRejectedValue(Error("offline"));
  threads.decidePermission(s.key, "p", "yes", "allow", true);
  await vi.advanceTimersByTimeAsync(1);
  expect(s.pendingPermissions[0].error).toBeTruthy();
  expect(s.pendingPermissions[0].decision).toBeNull();
  h.invoke.mockClear();
  threads.decidePermission(s.key, "p", "yes", "allow", true, true);
  event(s.key, { kind: "connectionLost" });
  await vi.advanceTimersByTimeAsync(5001);
  expect(s.pendingPermissions).toEqual([]);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("disabled work preserves queue and reenabling does not send until requested", async () => {
  const s = seed("work");
  threads.updateWork("/p", { a: false });
  await threads.send(s.key, [{ type: "text", text: "wait" }]);
  expect(s.queued).toHaveLength(1);
  expect(h.invoke).not.toHaveBeenCalled();
  threads.updateWork("/p", { a: true });
  expect(h.invoke).not.toHaveBeenCalled();
  h.invoke.mockResolvedValue({ status: "accepted" });
  await threads.continueQueue(s.key);
  expect(s.queued).toHaveLength(0);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_prompt"),
  ).toHaveLength(1);
});
it("unknown submission stays visible but cannot be repeated", async () => {
  const s = seed("unknown");
  h.invoke.mockResolvedValue({ status: "unknown", reason: "uncertain" });
  await threads.send(s.key, [{ type: "text", text: "once" }]);
  expect(s.queued).toHaveLength(1);
  expect(s.uncertainPrompt).toBe(s.queued[0]);
  await threads.continueQueue(s.key);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_prompt"),
  ).toHaveLength(1);
  threads.dequeue(s.key, 0);
  expect(s.uncertainPrompt).toBeNull();
});
it("does not consume queue until acknowledgement even if completion arrives first", async () => {
  const s = seed("ack");
  let accept!: (v: unknown) => void;
  h.invoke.mockImplementation((cmd: string) =>
    cmd === "session_prompt"
      ? new Promise((resolve) => {
          accept = resolve;
        })
      : Promise.resolve(cmd === "settings_get" ? 0 : []),
  );
  const sending = threads.send(s.key, [{ type: "text", text: "once" }]);
  expect(s.queued).toHaveLength(1);
  event(s.key, { kind: "turnEnd", stopReason: "end_turn" });
  expect(s.queued).toHaveLength(1);
  accept({ status: "accepted" });
  await sending;
  expect(s.queued).toHaveLength(0);
  expect(s.running).toBe(false);
});
it("configuration failure blocks draft submission until a successful selection", async () => {
  const s = seed("config");
  s.identity = "draft";
  h.invoke.mockRejectedValue(Error("bad config"));
  await expect(threads.setConfig(s.key, "model", "x")).rejects.toBeTruthy();
  await expect(
    threads.send(s.key, [{ type: "text", text: "wait" }]),
  ).rejects.toBeTruthy();
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_prompt"),
  ).toHaveLength(0);
  h.invoke.mockResolvedValue([]);
  await threads.setConfig(s.key, "model", "y");
  expect(s.configError).toBeNull();
});
it("reconnect buffers replacement history and ignores a stale channel", async () => {
  const options = {
    cwd: "/p",
    nativeSessionId: "replay",
    resumed: true,
    configOptions: [],
  };
  h.invoke.mockImplementation(async (cmd: string) =>
    cmd === "session_open" ? options : cmd === "settings_get" ? 0 : [],
  );
  const s = await threads.open({
    agentId: "a",
    cwd: "/p",
    nativeSessionId: "replay",
  });
  const old = h.invoke.mock.calls.find(([cmd]) => cmd === "session_open")![1]
    .channel as { onmessage: (v: unknown) => void };
  old.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "old text" },
    },
  });
  s.queued = [[{ type: "text", text: "keep queued" }]];
  s.connectionLost = true;
  let resolve!: (v: unknown) => void;
  let incoming!: { onmessage: (v: unknown) => void };
  h.invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "session_open") {
      incoming = args.channel as typeof incoming;
      return new Promise((done) => {
        resolve = done;
      });
    }
    return Promise.resolve(cmd === "settings_get" ? 0 : []);
  });
  const retry = threads.reconnect(s.key);
  expect(threads.thread(s.key)).toBe(s);
  expect(s.reconnecting).toBe(true);
  old.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "STALE" },
    },
  });
  incoming.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "restored text" },
    },
  });
  resolve(options);
  await retry;
  const restored = threads.thread(s.key)!;
  expect(
    restored.items
      .filter((i) => i.kind === "agent")
      .map((i) => (i.kind === "agent" ? i.text : "")),
  ).toEqual(["restored text"]);
  expect(restored.queued).toBe(s.queued);
  expect(restored.identity).toBe("established");
  old.onmessage({ kind: "connectionLost" });
  expect(restored.connectionLost).toBe(false);
});

it("connection loss while acknowledgement is pending quarantines the message", async () => {
  const s = seed("lost-ack");
  let done!: (v: unknown) => void;
  h.invoke.mockImplementation((cmd: string) =>
    cmd === "session_prompt"
      ? new Promise((resolve) => {
          done = resolve;
        })
      : Promise.resolve([]),
  );
  const request = threads.send(s.key, [{ type: "text", text: "once" }]);
  event(s.key, { kind: "connectionLost" });
  expect(s.uncertainPrompt).toBe(s.queued[0]);
  expect(s.queuePaused).toBe("uncertain");
  done({ status: "unknown" });
  await request;
  await threads.continueQueue(s.key);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_prompt"),
  ).toHaveLength(1);
});
