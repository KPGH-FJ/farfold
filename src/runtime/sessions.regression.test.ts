import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, paneCards, hasPendingRequests } from "./sessions";
import { draftPersistence, draftQueues } from "./drafts";
import { archiveActivity } from "./archive_activity";
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  // Activity persistence is covered by sessions.outcomes/auto_archive tests.
  // These response fixtures deliberately model only the command under test.
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  h.invoke.mockImplementation(async (cmd: string) =>
    cmd === "settings_get"
      ? 0
      : cmd.endsWith("_respond")
        ? { status: "submitted" }
        : [],
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  h.invoke.mockReset();
});
function seed(id: string) {
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  return s;
}
it("locks an established conversation's reasoning without disabling unrelated options", async () => {
  const state = seed("locked-thought");
  state.identity = "established";
  state.configOptions = [
    {
      id: "depth",
      name: "Depth",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "ask",
      options: [],
    },
  ];
  await expect(
    threads.setConfig(state.key, "depth", "low"),
  ).rejects.toBeTruthy();
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_set_config"),
  ).toBe(false);
  await threads.setConfig(state.key, "mode", "plan");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_set_config"),
  ).toBe(true);
});

it("distinguishes an idle disconnect from an unconfirmed running request", () => {
  const idle = seed("idle-close");
  idle.items.push({
    kind: "agent",
    id: "already-done",
    text: "Finished",
    streaming: false,
    time: 0,
  });
  event(idle.key, { kind: "connectionLost" });
  expect(idle.connectionLost).toBe(true);
  expect(idle.connectionOutcomeUnknown).toBe(false);
  expect(threads.needsAttention(idle)).toBe(false);
  const running = seed("running-close");
  running.running = true;
  event(running.key, { kind: "connectionLost" });
  expect(running.connectionOutcomeUnknown).toBe(true);
  expect(threads.needsAttention(running)).toBe(true);
});
it("never discards an unaccepted draft while submitted content or a request remains", async () => {
  const queued = seed("discard-queued");
  queued.identity = "draft";
  queued.queued = [[{ type: "text", text: "Keep queued input" }]];
  await threads.discardDraft(queued.key);
  expect(threads.thread(queued.key)).toBe(queued);
  const pending = seed("discard-pending");
  pending.identity = "draft";
  permission(pending.key, "still-waiting");
  await threads.discardDraft(pending.key);
  expect(threads.thread(pending.key)).toBe(pending);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_close"),
  ).toBe(false);
});
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

it("keeps mixed requests and their form values independent through out-of-order replies", async () => {
  const s = seed("mixed-forms"),
    other = seed("mixed-other");
  const own = vi.fn(),
    unrelated = vi.fn(),
    summary = vi.fn();
  const unsubscribes = [
    threads.subscribeThread(s.key, own),
    threads.subscribeThread(other.key, unrelated),
    threads.subscribe(summary),
  ];
  try {
    permission(s.key, "permission");
    for (const id of ["form-a", "form-b"])
      event(s.key, {
        kind: "elicitation",
        requestId: id,
        message: id,
        schema: { type: "object", properties: { answer: { type: "string" } } },
      });
    expect(hasPendingRequests(s)).toBe(true);
    expect(threads.needsAttention(s)).toBe(true);
    const beforeEditing = summary.mock.calls.length;
    threads.setElicitationValue(s.key, "form-a", "answer", "first");
    threads.setElicitationValue(s.key, "form-b", "answer", "second");
    event(s.key, {
      kind: "elicitation",
      requestId: "form-a",
      message: "duplicate",
    });
    expect(s.pendingElicitations.map((p) => p.values.answer)).toEqual([
      "first",
      "second",
    ]);
    expect(summary.mock.calls.length).toBe(beforeEditing + 1);
    expect(own).toHaveBeenCalled();
    expect(unrelated).not.toHaveBeenCalled();
    let finish!: (value: unknown) => void;
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "session_elicitation_respond"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve([]),
    );
    const reply = threads.respondElicitation(s.key, "form-b", "accept");
    await threads.respondElicitation(s.key, "form-b", "accept");
    expect(
      h.invoke.mock.calls.filter(
        ([cmd]) => cmd === "session_elicitation_respond",
      ),
    ).toHaveLength(1);
    expect(s.pendingElicitations[1].status).toBe("submitting");
    expect(s.pendingElicitations).toHaveLength(2);
    expect(h.invoke).toHaveBeenCalledWith("session_elicitation_respond", {
      requestId: "form-b",
      sessionId: s.nativeSessionId,
      action: "accept",
      content: { answer: "second" },
    });
    finish({ status: "submitted" });
    await reply;
    expect(s.pendingElicitations.map((p) => p.requestId)).toEqual(["form-a"]);
    expect(s.pendingElicitations[0].values).toEqual({ answer: "first" });
    expect(s.pendingPermissions.map((p) => p.requestId)).toEqual([
      "permission",
    ]);
  } finally {
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  }
});

it("allows an explicitly retryable form reply but never repeats an unknown reply", async () => {
  const s = seed("form-retry");
  event(s.key, { kind: "elicitation", requestId: "form", message: "answer" });
  threads.setElicitationValue(s.key, "form", "answer", "kept");
  h.invoke.mockResolvedValueOnce({
    status: "retryable",
    message: "invalid protocol parameters",
  });
  await threads.respondElicitation(s.key, "form", "accept");
  expect(s.pendingElicitations[0]).toMatchObject({
    status: "pending",
    values: { answer: "kept" },
  });
  expect(s.pendingElicitations[0].error).not.toContain("protocol");
  h.invoke.mockRejectedValueOnce(Error("IPC disconnected"));
  await threads.respondElicitation(s.key, "form", "accept");
  expect(s.pendingElicitations[0].status).toBe("uncertain");
  await threads.respondElicitation(s.key, "form", "cancel");
  expect(
    h.invoke.mock.calls.filter(
      ([cmd]) => cmd === "session_elicitation_respond",
    ),
  ).toHaveLength(2);
  expect(s.items.some((item) => item.kind === "settled")).toBe(false);
  expect(hasPendingRequests(s)).toBe(true);
});

it("unknown approval delivery cannot be retried, and expired replies resolve without approval", async () => {
  vi.useFakeTimers();
  const s = seed("approval-unknown");
  permission(s.key, "unknown");
  h.invoke.mockResolvedValue({ status: "uncertain" });
  threads.decidePermission(s.key, "unknown", "yes", "allow", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.pendingPermissions[0].status).toBe("uncertain");
  threads.decidePermission(s.key, "unknown", "yes", "allow again", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "session_permission_respond"),
  ).toHaveLength(1);
  event(s.key, { kind: "elicitation", requestId: "expired" });
  h.invoke.mockResolvedValue({ status: "expired" });
  await threads.respondElicitation(s.key, "expired", "cancel");
  expect(s.pendingElicitations).toEqual([]);
  expect(s.items.at(-1)).toMatchObject({ kind: "notice" });
  expect(s.items.some((item) => item.kind === "decision")).toBe(false);
});

it("terminal cleanup and remote expiry prevent late replies from resurrecting requests", async () => {
  vi.useFakeTimers();
  for (const terminal of [
    "turnEnd",
    "connectionLost",
    "interactionsCancelled",
    "close",
  ]) {
    const s = seed(`interaction-${terminal}`);
    s.running = true;
    permission(s.key, "permission");
    threads.decidePermission(
      s.key,
      "permission",
      "yes",
      "remember",
      true,
      true,
    );
    event(s.key, { kind: "elicitation", requestId: "form" });
    let finish!: (value: unknown) => void;
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "session_elicitation_respond"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(cmd === "settings_get" ? 0 : []),
    );
    const reply = threads.respondElicitation(s.key, "form", "accept");
    if (terminal === "close") await threads.close(s.key);
    else event(s.key, { kind: terminal, stopReason: "cancelled" });
    finish({ status: "submitted" });
    await reply;
    await vi.advanceTimersByTimeAsync(5001);
    expect(threads.thread(s.key) ? hasPendingRequests(s) : false).toBe(false);
    expect(s.items.some((item) => item.kind === "decision")).toBe(false);
    expect(
      h.invoke.mock.calls.some(([cmd]) => cmd === "session_permission_respond"),
    ).toBe(false);
    h.invoke.mockClear();
  }
  const s = seed("single-expiry");
  for (const requestId of ["gone", "keep"])
    event(s.key, { kind: "elicitation", requestId });
  permission(s.key, "permission-kept");
  event(s.key, { kind: "interactionExpired", requestId: "gone" });
  event(s.key, { kind: "interactionExpired", requestId: "gone" });
  expect(s.pendingElicitations.map((p) => p.requestId)).toEqual(["keep"]);
  expect(s.pendingPermissions).toHaveLength(1);
  expect(s.items.filter((item) => item.kind === "notice")).toHaveLength(1);
});
it("does not suppress a remembered decision when another request arrives", async () => {
  vi.useFakeTimers();
  h.invoke.mockResolvedValue({ status: "submitted" });
  const s = seed("delay");
  permission(s.key, "p1");
  threads.decidePermission(s.key, "p1", "yes", "allow", true, true);
  expect(s.pendingPermissions[0].decision?.undoable).toBe(true);
  permission(s.key, "p2");
  await vi.advanceTimersByTimeAsync(4999);
  expect(h.invoke).not.toHaveBeenCalled();
  threads.decidePermission(s.key, "p2", "yes", "allow once", true);
  expect(s.pendingPermissions[1].decision?.undoable).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.invoke).toHaveBeenCalledWith(
    "session_permission_respond",
    expect.objectContaining({ requestId: "p2" }),
  );
  expect(s.pendingPermissions.map((p) => p.requestId)).toEqual(["p1"]);
  await vi.advanceTimersByTimeAsync(2);
  expect(h.invoke).toHaveBeenCalledWith(
    "session_permission_respond",
    expect.objectContaining({ requestId: "p1" }),
  );
  expect(s.pendingPermissions).toEqual([]);
});

it("withdraws only unsent local decisions when stopping, even if cancellation immediately becomes unknown", async () => {
  vi.useFakeTimers();
  const s = seed("stop-remembered");
  s.running = true;
  permission(s.key, "remembered");
  permission(s.key, "already-submitting");
  const original = s.pendingPermissions[0];
  const submitting = s.pendingPermissions[1];
  submitting.status = "submitting";
  threads.decidePermission(s.key, "remembered", "yes", "remember", true, true);
  h.invoke.mockRejectedValueOnce(new Error("transport failure"));
  await threads.cancel(s.key);
  expect(s.stopUnconfirmed).toBe(true);
  expect(original.decision).toBeNull();
  expect(s.pendingPermissions[0]).toBe(original);
  expect(submitting.status).toBe("submitting");
  await vi.advanceTimersByTimeAsync(5001);
  expect(
    h.invoke.mock.calls.some(
      ([command]) => command === "session_permission_respond",
    ),
  ).toBe(false);
  h.invoke.mockResolvedValue({ status: "submitted" });
  threads.decidePermission(
    s.key,
    "remembered",
    "yes",
    "allow explicitly",
    true,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "session_permission_respond",
    expect.objectContaining({
      sessionId: s.nativeSessionId,
      requestId: "remembered",
    }),
  );
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
  h.invoke.mockImplementation(async (cmd: string, args) => {
    if (cmd === "session_open") {
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "History" },
        },
      });
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return {
        cwd: "/p",
        nativeSessionId: "loaded",
        resumed: true,
        configOptions: options,
      };
    }
    return cmd === "settings_get" ? 0 : [];
  });
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
it("renders passive terminal output deltas in the matching command artifact", () => {
  const s = seed("terminal-output");
  event(s.key, {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "cmd",
      kind: "execute",
      title: "cat proof.txt",
      content: [{ type: "terminal", terminalId: "term" }],
    },
  });
  event(s.key, {
    kind: "toolOutput",
    toolCallId: "cmd",
    terminalId: "term",
    data: "FARFOLD-",
  });
  event(s.key, {
    kind: "toolOutput",
    toolCallId: "cmd",
    terminalId: "other",
    data: "WRONG",
  });
  event(s.key, {
    kind: "toolOutput",
    toolCallId: "cmd",
    terminalId: "term",
    data: "OUTPUT-OK",
  });
  expect(paneCards(s)[0]).toMatchObject({
    kind: "command",
    output: "FARFOLD-OUTPUT-OK",
  });
});
it("structured terminal failure takes precedence over end_turn and pauses queue", () => {
  const s = seed("typed-failure");
  s.running = true;
  s.queued = [[{ type: "text", text: "keep" }]];
  event(s.key, {
    kind: "turnEnd",
    stopReason: "end_turn",
    failure: { category: "service" },
  });
  expect(s.items.at(-1)).toMatchObject({ kind: "settled", status: "failed" });
  expect(s.queuePaused).toBe("failed");
  expect(s.queued).toHaveLength(1);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
});
it.each([undefined, "future_reason", "refusal", "max_tokens"])(
  "does not mark %s as successful completion",
  (stopReason) => {
    const s = seed(`reason-${stopReason}`);
    s.running = true;
    event(s.key, { kind: "turnEnd", stopReason });
    expect(s.items.at(-1)).not.toMatchObject({ status: "done" });
    expect(s.queuePaused).toBeTruthy();
  },
);
it("unacknowledged stop becomes unknown, retains queue and accepts a late result once", async () => {
  vi.useFakeTimers();
  const s = seed("stop-timeout");
  s.running = true;
  s.queued = [[{ type: "text", text: "keep" }]];
  await threads.cancel(s.key);
  await vi.advanceTimersByTimeAsync(30000);
  expect(s.stopping).toBe(false);
  expect(s.stopUnconfirmed).toBe(true);
  expect(threads.needsAttention(s)).toBe(true);
  await threads.continueQueue(s.key);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
  expect(s.queued).toHaveLength(1);
  event(s.key, { kind: "turnEnd", stopReason: "cancelled" });
  event(s.key, { kind: "turnEnd", stopReason: "cancelled" });
  expect(s.stopUnconfirmed).toBe(false);
  expect(s.items.filter((i) => i.kind === "settled")).toHaveLength(1);
  expect(s.items.at(-1)).toMatchObject({ status: "stopped" });
});
it("confirmed stop cancels its deadline and cannot change a later task", async () => {
  vi.useFakeTimers();
  const s = seed("stop-confirmed");
  s.running = true;
  await threads.cancel(s.key);
  event(s.key, { kind: "turnEnd", stopReason: "cancelled" });
  s.running = true;
  await vi.advanceTimersByTimeAsync(30000);
  expect(s.stopUnconfirmed).toBe(false);
});
it("a late failure from an expired stop cannot cancel the retry's confirmation wait", async () => {
  vi.useFakeTimers();
  const s = seed("stop-late-rejection");
  s.running = true;
  let rejectFirst!: (error: Error) => void;
  h.invoke.mockImplementationOnce(
    () => new Promise((_, reject) => (rejectFirst = reject)),
  );
  const first = threads.cancel(s.key);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.stopUnconfirmed).toBe(true);
  await threads.cancel(s.key);
  expect(s.stopping).toBe(true);
  rejectFirst(new Error("late failure"));
  await first;
  expect(s.stopping).toBe(true);
  expect(s.stopUnconfirmed).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.stopping).toBe(false);
  expect(s.stopUnconfirmed).toBe(true);
});
it("a late stop failure cannot mark a later task's outcome unknown", async () => {
  vi.useFakeTimers();
  const s = seed("stop-late-failure-new-task");
  s.running = true;
  let rejectStop!: (error: Error) => void;
  h.invoke.mockImplementationOnce(
    () => new Promise((_, reject) => (rejectStop = reject)),
  );
  const stopped = threads.cancel(s.key);
  event(s.key, { kind: "turnEnd", stopReason: "cancelled" });
  s.running = true;
  s.queuePaused = null;
  rejectStop(new Error("late failure"));
  await stopped;
  expect(s.stopUnconfirmed).toBe(false);
  expect(s.queuePaused).toBeNull();
});
it("model drift blocks direct sends and queued continuation", async () => {
  const s = seed("drift-send");
  s.modelDrift = true;
  await threads.send(s.key, [{ type: "text", text: "keep" }]);
  await threads.continueQueue(s.key);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
});
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
  h.invoke.mockResolvedValue({ status: "retryable" });
  threads.decidePermission(s.key, "p", "yes", "allow", true);
  await vi.advanceTimersByTimeAsync(1);
  expect(s.pendingPermissions[0].error).toBeTruthy();
  expect(s.pendingPermissions[0].decision).toBeNull();
  expect(s.pendingPermissions[0].status).toBe("pending");
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
  expect(s.uncertainPrompt).toBe(s.queued[0]);
  expect(s.queued).toHaveLength(1);
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
  await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
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
  h.invoke.mockImplementation(async (cmd: string, args) => {
    if (cmd === "agent_work_get") return { cwd: args.cwd, enabled: {} };
    if (cmd === "session_open") {
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Initial history" },
        },
      });
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return options;
    }
    return cmd === "settings_get" ? 0 : [];
  });
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
  let incomingToken: unknown;
  h.invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "session_open") {
      incoming = args.channel as typeof incoming;
      incomingToken = args.openToken;
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
  incoming.onmessage({
    kind: "session_history_complete",
    openToken: incomingToken,
  });
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
  await vi.waitFor(() => expect(done).toBeTypeOf("function"));
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

it("does not dispatch queued input until its pending snapshot is saved", async () => {
  const state = seed("durable-admission");
  let saved!: () => void;
  vi.mocked(draftPersistence.flush).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  h.invoke.mockImplementation(async (command) =>
    command === "session_prompt" ? { status: "accepted" } : [],
  );
  const sending = threads.send(state.key, [
    { type: "text", text: "Only after save" },
  ]);
  await vi.waitFor(() => expect(saved).toBeTypeOf("function"));
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(draftQueues.read(state.key)).toMatchObject({ uncertainIndex: 0 });
  saved();
  expect(await sending).toEqual({ status: "accepted" });
  expect(draftQueues.read(state.key)).toBeNull();
});

it("preserves definitely unsent content when saving fails", async () => {
  const state = seed("failed-durable-admission");
  vi.mocked(draftPersistence.flush).mockRejectedValueOnce(
    new Error("Save failed"),
  );
  expect(
    await threads.send(state.key, [{ type: "text", text: "Keep unsent" }]),
  ).toEqual({ status: "rejected", reason: "failed" });
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(state.uncertainPrompt).toBeNull();
  expect(state.queuePaused).toBe("failed");
  expect(draftQueues.read(state.key)).toMatchObject({
    uncertainIndex: null,
    blocks: [[{ type: "text", text: "Keep unsent" }]],
  });
});

it("restores pending input as paused and never dispatches during cold opening", async () => {
  const key = "restored-queue:/p:pending";
  draftQueues.write(
    key,
    [
      [{ type: "text", text: "Unknown previous send" }],
      [{ type: "text", text: "Next unsent" }],
    ],
    0,
  );
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    args.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Prior history" },
      },
    });
    args.channel.onmessage({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    return { cwd: "/p", nativeSessionId: "pending", resumed: true };
  });
  const state = await threads.open({
    agentId: "restored-queue",
    cwd: "/p",
    nativeSessionId: "pending",
  });
  expect(state.queued).toHaveLength(2);
  expect(state.uncertainPrompt).toBe(state.queued[0]);
  expect(state.queuePaused).toBe("uncertain");
  expect(threads.needsAttention(state)).toBe(true);
  await threads.continueQueue(key);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("prepares a new empty Agent conversation after an unsent draft's idle connection ended", async () => {
  let created = 0;
  h.invoke.mockImplementation(async (command) =>
    command === "session_open"
      ? {
          cwd: "/p",
          nativeSessionId: `idle-draft-${++created}`,
          resumed: false,
        }
      : [],
  );
  const original = await threads.open({ agentId: "idle-draft", cwd: "/p" });
  event(original.key, { kind: "connectionLost" });
  const replacement = await threads.open({ agentId: "idle-draft", cwd: "/p" });
  expect(replacement.key).not.toBe(original.key);
  expect(replacement.connectionLost).toBe(false);
  expect(replacement.identity).toBe("draft");
  expect(created).toBe(2);
});

it("batches text per thread, publishes approvals immediately, and survives hidden frames", () => {
  vi.useFakeTimers();
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frame = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const a = seed("batch-a"),
    b = seed("batch-b");
  const seenA: unknown[] = [],
    seenB = vi.fn(),
    global = vi.fn();
  const stopA = threads.subscribeThread(a.key, () =>
    seenA.push({ text: a.items[0], pending: a.pendingPermissions.length }),
  );
  const stopB = threads.subscribeThread(b.key, seenB);
  const stopGlobal = threads.subscribe(global);
  const chunk = (key: string, text: string) =>
    event(key, {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  chunk(a.key, "first");
  chunk(a.key, " second");
  expect(a.items[0]).toMatchObject({ text: "first second" });
  expect(seenA).toHaveLength(0);
  frame?.(0);
  expect(seenA).toHaveLength(1);
  expect(seenB).not.toHaveBeenCalled();
  expect(global).not.toHaveBeenCalled();
  chunk(a.key, " third");
  permission(a.key, "now");
  expect(seenA).toHaveLength(2);
  expect(seenA[1]).toMatchObject({
    pending: 1,
    text: { text: "first second third" },
  });
  expect(global).toHaveBeenCalledTimes(1);
  expect(seenB).not.toHaveBeenCalled();
  chunk(b.key, "background");
  vi.advanceTimersByTime(32);
  expect(seenB).toHaveBeenCalledTimes(1);
  stopA();
  stopB();
  stopGlobal();
  vi.unstubAllGlobals();
});

it("publishes final text with completion without awaiting a display frame", () => {
  vi.useFakeTimers();
  const s = seed("batch-end");
  s.running = true;
  const seen = vi.fn();
  const stop = threads.subscribeThread(s.key, seen);
  event(s.key, {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "last" },
    },
  });
  event(s.key, { kind: "turnEnd", stopReason: "end_turn" });
  expect(seen).toHaveBeenCalledTimes(1);
  expect(s.running).toBe(false);
  expect(s.items[0]).toMatchObject({ text: "last", streaming: false });
  expect(s.items.at(-1)).toMatchObject({ status: "done" });
  stop();
});

it("opens a fresh drift recovery draft without carrying history or queued prompts, and permits retry", async () => {
  const old = seed("drift-exit");
  old.modelDrift = true;
  old.identity = "established";
  old.items = [
    {
      kind: "agent",
      id: "old",
      text: "keep history",
      streaming: false,
      time: 1,
    },
  ];
  old.queued = [[{ type: "text", text: "do not send" }]];
  let fail = true;
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "session_open") {
      if (fail) throw new Error("fixture unavailable");
      return {
        cwd: "/p",
        nativeSessionId: "drift-new",
        resumed: false,
        configOptions: [],
      };
    }
    return cmd === "settings_get" ? 0 : [];
  });
  await expect(threads.newAfterRecoveryFailure(old.key)).rejects.toBeTruthy();
  fail = false;
  const fresh = await threads.newAfterRecoveryFailure(old.key);
  expect(fresh).toMatchObject({
    agentId: old.agentId,
    cwd: old.cwd,
    identity: "draft",
    items: [],
    queued: [],
    modelDrift: false,
  });
  expect(old.items[0]).toMatchObject({ text: "keep history" });
  expect(old.queued).toHaveLength(1);
  expect(old.modelDrift).toBe(true);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
  expect(
    h.invoke.mock.calls
      .filter(([cmd]) => cmd === "session_open")
      .every(([, args]) => args.nativeSessionId === null),
  ).toBe(true);
});

it("retains an unsupported inquiry and pauses queued work without manufacturing approval", () => {
  const s = seed("unsupported-inquiry");
  s.running = true;
  s.queued = [[{ type: "text", text: "keep" }]];
  event(s.key, {
    kind: "elicitationUnavailable",
    params: {
      mode: "url",
      url: "https://example.test/",
      _meta: { future: true },
    },
  });
  expect(s.items.at(-1)).toMatchObject({
    kind: "raw",
    update: { mode: "url", _meta: { future: true } },
  });
  expect(s.pendingElicitations).toEqual([]);
  expect(s.queuePaused).toBe("unavailable");
  expect(
    h.invoke.mock.calls.some(([cmd]) => cmd === "session_elicitation_respond"),
  ).toBe(false);
});

it("uses backend reasoning protection and never drains a queue on confirmation", async () => {
  const s = seed("reasoning-confirm");
  s.identity = "established";
  s.queued = [[{ type: "text", text: "keep paused" }]];
  const current = {
    model: { id: "model", category: "model", value: "m" },
    thoughtLevel: { id: "effort", category: "thought_level", value: "high" },
  };
  event(s.key, {
    kind: "configCheck",
    check: {
      status: "confirmation_required",
      issues: [
        {
          category: "thought_level",
          reason: "unrecorded",
          expected: null,
          current: "high",
        },
      ],
      current,
    },
  });
  expect(s.modelDrift).toBe(true);
  await threads.send(s.key, [{ type: "text", text: "blocked" }]);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd !== "session_confirm_config") return [];
    const check = { status: "ready", issues: [], current };
    event(s.key, { kind: "configCheck", check });
    return check;
  });
  await threads.confirmConfig(s.key);
  expect(h.invoke).toHaveBeenCalledWith(
    "session_confirm_config",
    expect.objectContaining({ displayed: current }),
  );
  expect(s.modelDrift).toBe(false);
  expect(s.queuePaused).toBe("unavailable");
  expect(s.queued[0][0]).toMatchObject({ text: "keep paused" });
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
});

it("preserves backend guard failure across ordinary config updates", () => {
  const s = seed("reasoning-event");
  event(s.key, {
    kind: "configCheck",
    check: {
      status: "blocked",
      issues: [
        {
          category: "thought_level",
          reason: "changed",
          expected: "low",
          current: "high",
        },
      ],
      current: {},
    },
  });
  event(s.key, {
    update: { sessionUpdate: "config_option_update", configOptions: [] },
  });
  expect(s.modelDrift).toBe(true);
  expect(s.configCheck?.issues[0].expected).toBe("low");
});

it("does not replace a newer guard notification with an older confirmation reply", async () => {
  const s = seed("confirm-race");
  event(s.key, {
    kind: "configCheck",
    check: {
      status: "confirmation_required",
      issues: [],
      current: { sample: "high" },
    },
  });
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd !== "session_confirm_config") return [];
    event(s.key, {
      kind: "configCheck",
      check: { status: "ready", issues: [], current: { sample: "high" } },
    });
    event(s.key, {
      kind: "configCheck",
      check: {
        status: "blocked",
        issues: [
          {
            category: "thought_level",
            reason: "changed",
            expected: "high",
            current: "low",
          },
        ],
        current: { sample: "low" },
      },
    });
    return { status: "ready", issues: [], current: { sample: "high" } };
  });
  await threads.confirmConfig(s.key);
  expect(s.modelDrift).toBe(true);
  expect(s.configCheck?.issues[0].current).toBe("low");
});

it("counts failed restores with no replay as needing attention", () => {
  const s = threads.markOpenFailed(
    "a:/p:empty-failed-restore",
    "a",
    "/p",
    "empty-failed-restore",
    "unavailable",
  );
  expect(s.items).toHaveLength(0);
  expect(threads.needsAttention(s)).toBe(true);
});

// The last confirmed setting survives a failed refresh; errors do not invent a default.
it("keeps the last confirmed archive setting when metadata is unavailable", async () => {
  h.invoke.mockImplementation(async (cmd: string) =>
    cmd === "settings_get" ? 60 : [],
  );
  await threads.refreshIndex();
  expect(threads.getSnapshot().autoArchiveDays).toBe(60);
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "settings_get") throw new Error("read failed");
    return [];
  });
  await threads.refreshIndex();
  expect(threads.getSnapshot().autoArchiveDays).toBe(60);
});

it("does not replace a saved archive preference with a stale read or a failed write", async () => {
  let resolveRead!: (value: number) => void;
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "settings_get")
      return new Promise<number>((resolve) => {
        resolveRead = resolve;
      });
    return [];
  });
  const refresh = threads.refreshIndex();
  await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
  await threads.setAutoArchiveDays(90);
  resolveRead(30);
  await refresh;
  expect(threads.getSnapshot().autoArchiveDays).toBe(90);
  h.invoke.mockRejectedValue(new Error("write failed"));
  await expect(threads.setAutoArchiveDays(10)).rejects.toThrow("write failed");
  expect(threads.getSnapshot().autoArchiveDays).toBe(90);
});

it("serializes archive saves across settings page remounts", async () => {
  let finishFirst!: () => void;
  h.invoke.mockImplementation(async (cmd: string, args: { value?: number }) => {
    if (cmd === "settings_set" && args.value === 40)
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
  });
  const first = threads.setAutoArchiveDays(40);
  const second = threads.setAutoArchiveDays(80);
  await vi.waitFor(() => expect(finishFirst).toBeTypeOf("function"));
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "settings_set"),
  ).toHaveLength(1);
  finishFirst();
  await Promise.all([first, second]);
  expect(threads.getSnapshot().autoArchiveDays).toBe(80);
});

it("isolates simultaneous drafts and event channels by selected API and key revision", async () => {
  let next = 0;
  const channels: { onmessage: (event: unknown) => void }[] = [];
  h.invoke.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) => {
      if (cmd !== "session_open") return [];
      channels.push(args.channel as { onmessage: (event: unknown) => void });
      return {
        cwd: "/source-test",
        nativeSessionId: `source-${++next}`,
        resumed: false,
        configOptions: [],
        service: args.service,
        serviceContext: `connection-${next}`,
      };
    },
  );
  const base = { agentId: "source-agent", cwd: "/source-test" };
  const a = {
    ...base,
    service: { id: "api-a", model: "same-model" },
    serviceRevision: "old-key",
  };
  const b = {
    ...base,
    service: { id: "api-b", model: "same-model" },
    serviceRevision: "old-key",
  };
  const [first, duplicate, other] = await Promise.all([
    threads.open(a),
    threads.open(a),
    threads.open(b),
  ]);
  expect(first.key).toBe(duplicate.key);
  expect(first.key).not.toBe(other.key);
  expect(next).toBe(2);
  channels[0].onmessage({
    kind: "serviceUnavailable",
    message: "API 配置已删除",
  });
  expect(first.sourceError).toBe(true);
  expect(other.sourceError).toBeUndefined();
  const rotated = await threads.open({ ...a, serviceRevision: "new-key" });
  expect(rotated.key).not.toBe(first.key);
  expect(next).toBe(3);
  const defaultSource = await threads.open(base);
  expect(defaultSource.service).toBeUndefined();
  expect(defaultSource.key).not.toBe(other.key);
});

it("preserves history and queued work if reconnecting a removed API fails", async () => {
  const s = seed("removed-api");
  s.service = { id: "removed", fingerprint: "url-format", model: "model" };
  s.serviceContext = "removed-context";
  s.items.push({
    kind: "notice",
    id: "preserved-history",
    message: "previous answer",
    time: 1,
  });
  event(s.key, { kind: "serviceUnavailable", message: "API 配置已删除" });
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "session_open") throw new Error("API 配置已删除");
    return [];
  });
  await threads.reconnect(s.key);
  expect(s.items.some((item) => item.id === "preserved-history")).toBe(true);
  expect(s.sourceError).toBe(true);
  expect(s.connectionLost).toBe(true);
  expect(h.invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
    "session_close",
    "session_open",
  ]);
});
