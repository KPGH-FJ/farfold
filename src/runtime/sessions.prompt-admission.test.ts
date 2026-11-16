import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadState, PromptBlock } from "./session_types";
import type { PromptAdmission } from "./queue";
import { failedWorkTarget } from "./stopped_work_close";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  prompts: [] as {
    args: Record<string, any>;
    resolve(value: PromptAdmission): void;
  }[],
  cancel: { receiptId: 11, outcome: "cancelledBeforeOffer" },
  notifications: null as
    import("./desktop_notifications").DesktopNotifications | null,
  submitNotification: vi.fn(
    async (
      _kind: string,
      _sequence: number,
      _target: string,
      _renderer: string,
    ) => "submitted",
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
vi.mock("./desktop_notifications", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./desktop_notifications")>();
  return {
    ...actual,
    observeDesktopNotification: (
      ...args: Parameters<typeof actual.observeDesktopNotification>
    ) => h.notifications?.observe(...args),
    beginSuccessDesktopNotification: (
      ...args: Parameters<typeof actual.beginSuccessDesktopNotification>
    ) => h.notifications?.beginSuccess(...args),
    checkDesktopNotifications: (
      ...args: Parameters<typeof actual.checkDesktopNotifications>
    ) => h.notifications?.checkSuccess(...args),
  };
});
let threads: typeof import("./sessions").threads;
let drafts: typeof import("./drafts");
const pending: Promise<unknown>[] = [];
let state: ThreadState;
const blocks: PromptBlock[] = [
  { type: "text", text: "FARFOLD_PUBLIC_PENDING_BODY" },
  {
    type: "resource_link",
    uri: "https://example.com/owned",
    name: "owned public link",
  },
];
beforeEach(async () => {
  vi.resetModules();
  h.prompts = [];
  h.cancel = { receiptId: 11, outcome: "cancelledBeforeOffer" };
  h.invoke.mockReset().mockImplementation((command, args) => {
    if (command === "settings_get") return Promise.resolve(null);
    if (command === "session_prompt")
      return new Promise<PromptAdmission>((resolve) =>
        h.prompts.push({ args, resolve }),
      );
    if (command === "session_prompt_cancel") return Promise.resolve(h.cancel);
    if (command === "session_index_list") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  h.submitNotification.mockClear();
  const { DesktopNotifications } = await vi.importActual<
    typeof import("./desktop_notifications")
  >("./desktop_notifications");
  h.notifications = new DesktopNotifications({
    read: async () => ({
      enabled: true,
      successEnabled: true,
      sound: false,
      permission: "authorized",
      systemAlert: true,
      systemSound: true,
      clickRequiresRunning: true,
    }),
    save: async () => null,
    submit: h.submitNotification,
    withdraw: async () => ({ state: "unknown" }),
    background: () => true,
  });
  await h.notifications.load();
  drafts = await import("./drafts");
  threads = (await import("./sessions")).threads;
  await drafts.draftPersistence.load();
  state = threads.markOpenFailed(
    "owned-prompt-wait",
    "owned",
    "/owned",
    "owned-session",
    "fixture",
  );
  state.openError = null;
  state.workEnabled = true;
  state.connectionId = "owned-connection";
  state.configCheck = { status: "ready", issues: [], current: { choices: [] } };
  drafts.composerDrafts.update(`session:${state.key}`, () => ({
    text: "keep local draft",
    attachments: [],
  }));
});
afterEach(async () => {
  for (const request of h.prompts) request.resolve({ status: "unknown" });
  await Promise.allSettled(pending.splice(0));
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown, live: boolean): void;
    }
  ).applyChannelEvent(state.key, { kind: "connectionLost" }, true);
  drafts.composerDrafts.clear(`session:${state.key}`);
  drafts.draftQueues.write(state.key, [], null);
  await drafts.draftPersistence.flush();
});
async function send() {
  const request = threads.send(state.key, blocks);
  pending.push(request);
  await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
  return { request, ...h.prompts[0] };
}
function progress(args: Record<string, any>, phase: string, receiptId = 11) {
  args.admissionChannel.onmessage({ receiptId, phase });
}
function event(value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown, live: boolean): void;
    }
  ).applyChannelEvent(state.key, value, true);
}
const calls = (name: string) =>
  h.invoke.mock.calls.filter(([command]) => command === name);

it.each([true, false])(
  "closes only the owned failed connection whether the process event or command result arrives first (%s)",
  async (eventFirst) => {
    const { request, args, resolve } = await send();
    progress(args, "offered");
    resolve({ status: "accepted" });
    await request;
    const error = {
      kind: "turnEnd",
      error: "internal error",
      failedWorkCloseAvailable: true,
    };
    event({ ...error, promptReceiptId: 999 });
    event({ ...error, promptReceiptId: 11, sessionId: state.nativeSessionId });
    expect(failedWorkTarget(state)).toBeNull();
    event({ ...error, promptReceiptId: 11 });
    const target = failedWorkTarget(state)!;
    expect(target).toMatchObject({
      connectionId: "owned-connection",
      sessionId: "owned-session",
    });
    const other = threads.markOpenFailed(
      "neighbor",
      "owned",
      "/neighbor",
      "other-session",
      "fixture",
    );
    other.connectionId = "other-connection";
    other.running = true;
    const queued = [
      { type: "text", text: "keep queued message" },
    ] satisfies PromptBlock[];
    state.queued = [queued];
    const localDraft = drafts.composerDrafts.read(`session:${state.key}`);
    const proof = {
      connectionId: target.connectionId,
      sessionId: target.sessionId,
      proofId: "8",
    };
    const { ProcessEndedChannel } = await import("./session_process_ended");
    const channel = new ProcessEndedChannel(
      (key) => threads.thread(key),
      (_key, message) => event(message),
    );
    channel.bind(state);
    const ended = { connectionId: proof.connectionId, closeReason: "user" };
    const fallback = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (command, payload) => {
      if (command === "prepare_failed_work_close") return proof;
      if (command === "close_failed_work") {
        if (eventFirst) channel.onmessage(ended);
        return proof;
      }
      return fallback(command, payload);
    });

    expect(await threads.workConnectionClose.check(state, target)).toEqual(
      proof,
    );
    expect(calls("close_failed_work")).toHaveLength(0);
    await expect(
      threads.workConnectionClose.close(state, target, {
        ...proof,
        sessionId: other.nativeSessionId,
      }),
    ).rejects.toThrow();
    expect(calls("close_failed_work")).toHaveLength(0);
    const previousItems = state.items.slice();
    await threads.workConnectionClose.close(state, target, proof);
    if (!eventFirst) channel.onmessage(ended);
    expect(calls("close_failed_work")).toEqual([
      [
        "close_failed_work",
        { agentId: state.agentId, cwd: state.cwd, ...proof },
      ],
    ]);
    expect(state.items).toEqual(previousItems);
    expect(state).toMatchObject({
      connectionLost: true,
      connectionOutcomeUnknown: false,
      historicalOutcomeUnknown: true,
      processEndedConnectionId: proof.connectionId,
      queuePaused: "stopped",
    });
    expect(failedWorkTarget(state)).toBeNull();
    expect(state.queued).toEqual([queued]);
    expect(drafts.composerDrafts.read(`session:${state.key}`)).toEqual(
      localDraft,
    );
    expect(other).toMatchObject({ running: true, connectionLost: false });
    expect(calls("session_prompt")).toHaveLength(1);
  },
);

it("a definite wait timeout keeps the existing conversation queue and rejects late offered progress without retry", async () => {
  const draft = drafts.composerDrafts.read(`session:${state.key}`);
  const { request, args, resolve } = await send();
  progress(args, "waiting");
  resolve({ status: "rejected", reason: "send_wait_timeout" });
  await expect(request).resolves.toEqual({
    status: "rejected",
    reason: "send_wait_timeout",
  });
  progress(args, "offered");
  expect(state.items).toContainEqual(
    expect.objectContaining({
      kind: "notice",
      message:
        "等待发送已结束，原内容已保留。请检查正在进行的任务，再明确重试。",
    }),
  );
  expect(state.identity).toBe("established");
  expect(state.running).toBe(false);
  expect(state.submitting).toBe(false);
  expect(state.uncertainPrompt).toBeNull();
  expect(state.promptAdmission).toBeNull();
  expect(state.queuePaused).toBe("unavailable");
  expect(state.queued).toEqual([blocks]);
  expect(drafts.composerDrafts.read(`session:${state.key}`)).toBe(draft);
  expect(state.items.some((item) => item.kind === "user")).toBe(false);
  expect(calls("session_prompt")).toHaveLength(1);
  expect(calls("session_prompt_cancel")).toHaveLength(0);
  expect(calls("session_cancel")).toHaveLength(0);
});

it.each(["accepted", "unknown"] as const)(
  "an incidental timeout reason on %s cannot create an unsent notice or downgrade the conversation",
  async (status) => {
    const { request, resolve } = await send();
    resolve({ status, reason: "send_wait_timeout" });
    await request;
    expect(state.items.some((item) => item.kind === "notice")).toBe(false);
    expect(state.identity).toBe("established");
    expect(state.uncertainPrompt).toBe(status === "unknown" ? blocks : null);
    expect(state.connectionOutcomeUnknown).toBe(status === "unknown");
    expect(state.queued).toEqual(status === "unknown" ? [blocks] : []);
    expect(calls("session_prompt")).toHaveLength(1);
  },
);

it("real send waits without claiming Agent work and keeps the exact queue/draft before a confirmed cancel", async () => {
  const before = drafts.composerDrafts.read(`session:${state.key}`);
  const { request, args, resolve } = await send();
  progress(args, "waiting");
  expect(state.submitting).toBe(true);
  expect(state.running).toBe(false);
  expect(state.queued[0]).toBe(blocks);
  expect(drafts.composerDrafts.read(`session:${state.key}`)).toBe(before);
  expect(args.content).toEqual(blocks);
  expect(args.expectedCurrent).toEqual({ choices: [] }); // no invented model
  expect(args.connectionId).toBe("owned-connection");
  await threads.cancel(state.key);
  expect(calls("session_cancel")).toHaveLength(0);
  expect(calls("session_prompt_cancel")[0][1]).toMatchObject({
    agentId: "owned",
    cwd: "/owned",
    sessionId: "owned-session",
    connectionId: "owned-connection",
    receiptId: 11,
    promptToken: args.promptToken,
  });
  expect(state.queued[0]).toBe(blocks);
  resolve({ status: "rejected", reason: "send_wait_cancelled" });
  await expect(request).resolves.toEqual({
    status: "rejected",
    reason: "send_wait_cancelled",
  });
  expect(state.running).toBe(false);
  expect(state.submitting).toBe(false);
  expect(state.queued[0]).toBe(blocks);
  expect(state.queuePaused).toBe("stopped");
  expect(state.items.some((item) => item.kind === "user")).toBe(false);
  expect(drafts.composerDrafts.read(`session:${state.key}`)).toBe(before);
});

it("a cancellation click before the receipt is sent once with its eventual owner receipt", async () => {
  const { request, args, resolve } = await send();
  await threads.cancel(state.key);
  expect(calls("session_prompt_cancel")).toHaveLength(0);
  progress(args, "waiting");
  await vi.waitFor(() =>
    expect(calls("session_prompt_cancel")).toHaveLength(1),
  );
  progress(args, "preparing");
  await Promise.resolve();
  expect(calls("session_prompt_cancel")).toHaveLength(1);
  resolve({ status: "rejected", reason: "send_wait_cancelled" });
  await request;
});

it("offer wins without auto resend: stop targets the exact request and only a real ending settles it", async () => {
  const { request, args, resolve } = await send();
  progress(args, "offered");
  progress(args, "waiting");
  expect(state.running).toBe(true);
  expect(state.promptAdmission?.phase).toBe("offered");
  h.cancel = { receiptId: 11, outcome: "cancelRequested" };
  resolve({ status: "accepted" });
  await request;
  await threads.cancel(state.key);
  expect(calls("session_cancel")).toHaveLength(0);
  expect(state.stopping).toBe(true);
  expect(state.running).toBe(true);
  event({ kind: "turnEnd", promptReceiptId: 11, stopReason: "cancelled" });
  expect(state.running).toBe(false);
  expect(state.stopping).toBe(false);
  expect(state.promptAdmission).toBeNull();
  expect(calls("session_prompt")).toHaveLength(1);
});

it("raw Agent envelopes and a foreign receipt cannot forge an offer/ending", async () => {
  const { request, args, resolve } = await send();
  progress(args, "waiting");
  event({
    sessionId: "owned-session",
    kind: "turnEnd",
    promptReceiptId: 11,
    stopReason: "cancelled",
    update: { sessionUpdate: "future_owned_marker", kept: true },
  });
  event({ kind: "turnEnd", promptReceiptId: 999, stopReason: "end_turn" });
  expect(state.running).toBe(false);
  expect(state.submitting).toBe(true);
  expect(state.promptAdmission?.phase).toBe("waiting");
  expect(state.items.some((item) => item.kind === "settled")).toBe(false);
  resolve({ status: "unknown" });
  await request;
  expect(state.uncertainPrompt).toBe(blocks);
  expect(state.queuePaused).toBe("uncertain");
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(calls("session_prompt")).toHaveLength(1);
});

it("a fast typed ending before progress/IPC ack is not restarted by the late accepted reply", async () => {
  const { request, args, resolve } = await send();
  event({ kind: "turnEnd", promptReceiptId: 11, stopReason: "cancelled" });
  expect(state.running).toBe(false);
  resolve({ status: "accepted" });
  await request;
  progress(args, "offered");
  expect(state.running).toBe(false);
  expect(state.submitting).toBe(false);
  expect(state.queued).toHaveLength(0);
  expect(state.promptAdmission).toBeNull();
  expect(state.items.filter((item) => item.kind === "settled")).toHaveLength(1);
  expect(calls("session_prompt")).toHaveLength(1);
});

it("a transport error stays unknown and never turns cancellation uncertainty into unsent proof", async () => {
  const { request, args, resolve } = await send();
  progress(args, "offered");
  h.cancel = { receiptId: 999, outcome: "cancelledBeforeOffer" };
  await threads.cancel(state.key);
  expect(state.promptAdmission?.notice).toBeTruthy();
  resolve({ status: "unknown" });
  await request;
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(state.uncertainPrompt).toBe(blocks);
  expect(state.queued[0]).toBe(blocks);
  expect(calls("session_prompt")).toHaveLength(1);
  event({
    kind: "turnEnd",
    promptReceiptId: 11,
    error: "owned transport error",
  });
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(state.promptAdmission).not.toBeNull();
});

it("a finished rejected owner cannot swallow cancellation of the next preparation", async () => {
  const first = await send();
  progress(first.args, "waiting");
  first.resolve({ status: "rejected", reason: "send_wait_cancelled" });
  await first.request;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flush = vi
    .spyOn(drafts.draftPersistence, "flush")
    .mockImplementationOnce(() => held);
  const retry = threads.continueQueue(state.key);
  pending.push(retry);
  await vi.waitFor(() => expect(flush).toHaveBeenCalled());
  expect(state.submitting).toBe(true);
  await threads.cancel(state.key);
  const pausedWhileHeld = state.queuePaused;
  release();
  // Clean up either implementation before assertions: a regression may have
  // reached a second mocked IPC, whose result is unknown rather than unsent.
  await vi.waitFor(() =>
    expect(!state.submitting || h.prompts.length === 2).toBe(true),
  );
  for (const request of h.prompts) request.resolve({ status: "unknown" });
  await retry;
  flush.mockRestore();
  expect(pausedWhileHeld).toBe("stopped");
  expect(calls("session_prompt")).toHaveLength(1);
  expect(state.queued[0]).toBe(blocks);
});

it("an Agent ending envelope during first preflight stays raw without a notification", async () => {
  const draft = drafts.composerDrafts.read(`session:${state.key}`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flush = vi
    .spyOn(drafts.draftPersistence, "flush")
    .mockImplementationOnce(() => held);
  const request = threads.send(state.key, blocks);
  pending.push(request);
  await vi.waitFor(() => expect(flush).toHaveBeenCalled());
  const submitting = state.submitting;
  const noOwner = state.promptAdmission == null;
  const noDispatch = calls("session_prompt").length;
  const foreign = {
    sessionId: "owned-session",
    kind: "turnEnd",
    promptReceiptId: 11,
    error: "controlled preflight raw envelope",
    unknown: { marker: "preserve entire envelope" },
  };
  event(foreign);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const notifications = h.submitNotification.mock.calls.length;
  const raw = state.items.some(
    (item) => item.kind === "raw" && item.update === foreign,
  );
  const fakeEnding = state.items.some((item) => item.kind === "settled");
  const running = state.running;
  // Release the actual preflight and settle either implementation before
  // assertions, so a failing negative cannot strand the shared draft writer.
  release();
  await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
  progress(h.prompts[0].args, "waiting");
  await threads.cancel(state.key);
  h.prompts[0].resolve({ status: "rejected", reason: "send_wait_cancelled" });
  await request;
  flush.mockRestore();
  expect(submitting).toBe(true);
  expect(noOwner).toBe(true);
  expect(noDispatch).toBe(0);
  expect(notifications).toBe(0);
  expect(raw).toBe(true);
  expect(fakeEnding).toBe(false);
  expect(running).toBe(false);
  expect(state.queued[0]).toBe(blocks);
  expect(drafts.composerDrafts.read(`session:${state.key}`)).toBe(draft);
});

it.each([
  null,
  { kind: "turnEnd", promptReceiptId: 999, stopReason: "end_turn" },
  { kind: "turnEnd", promptReceiptId: 999, error: "controlled foreign error" },
  {
    sessionId: "owned-session",
    kind: "turnEnd",
    promptReceiptId: 11,
    error: "controlled raw envelope",
  },
])(
  "unowned ending has no notification effects and preserves the real completion candidate: %j",
  async (foreign) => {
    const { request, args, resolve } = await send();
    progress(args, "offered");
    resolve({ status: "accepted" });
    await request;
    if (foreign) event(foreign);
    await Promise.resolve();
    const beforeOwnedEnding = h.submitNotification.mock.calls.length;
    event({
      sessionId: "owned-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "controlled public reply" },
      },
    });
    event({ kind: "turnEnd", promptReceiptId: 11, stopReason: "end_turn" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(beforeOwnedEnding).toBe(0);
    expect(h.submitNotification.mock.calls.map((call) => call[0])).toEqual([
      "success",
    ]);
    expect(state.running).toBe(false);
  },
);

it.each([
  { error: "AUTH_REQUIRED", waitFirst: false },
  { error: "owned transport error", waitFirst: true },
])(
  "an owned $error ending stays settled across late offered progress and accepted acknowledgement",
  async ({ error, waitFirst }) => {
    const { request, args, resolve } = await send();
    if (waitFirst) progress(args, "waiting");
    event({ kind: "turnEnd", promptReceiptId: 11, error });
    const ending = state.items.find((item) => item.kind === "settled");
    const draft = drafts.composerDrafts.read(`session:${state.key}`);
    expect(state.running).toBe(false);
    expect(state.connectionOutcomeUnknown).toBe(true);
    if (waitFirst) {
      h.cancel = { receiptId: 999, outcome: "cancelRequested" };
      await threads.cancel(state.key);
    }
    const notice = state.promptAdmission?.notice;
    progress(args, "offered");
    const afterProgress = {
      running: state.running,
      notice: state.promptAdmission?.notice,
    };
    resolve({ status: "accepted" });
    await request;
    expect(afterProgress).toEqual({ running: false, notice });
    expect(state.running).toBe(false);
    expect(state.connectionOutcomeUnknown).toBe(true);
    expect(state.promptAdmission).not.toBeNull();
    expect(state.items.filter((item) => item.kind === "settled")).toEqual([
      ending,
    ]);
    expect(drafts.composerDrafts.read(`session:${state.key}`)).toBe(draft);
    expect(calls("session_prompt")).toHaveLength(1);
    if (!waitFirst) {
      h.cancel = { receiptId: 11, outcome: "cancelRequested" };
      await threads.cancel(state.key);
      expect(calls("session_prompt_cancel")[0][1]).toMatchObject({
        connectionId: state.connectionId,
        promptToken: args.promptToken,
        receiptId: 11,
      });
      expect(state.stopping).toBe(true);
      expect(state.connectionOutcomeUnknown).toBe(true);
    } else {
      expect(notice).toBeTruthy();
      expect(state.stopUnconfirmed).toBe(true);
    }
  },
);

it("a cancel click before any receipt is delivered once when an owned error ending supplies the receipt", async () => {
  const { request, args, resolve } = await send();
  const draft = drafts.composerDrafts.read(`session:${state.key}`);
  await threads.cancel(state.key);
  expect(calls("session_prompt_cancel")).toHaveLength(0);
  h.cancel = { receiptId: 11, outcome: "cancelRequested" };
  event({
    kind: "turnEnd",
    promptReceiptId: 11,
    error: "owned early transport error",
  });
  resolve({ status: "accepted" });
  await request;
  // No progress message follows: the real ending itself is the first receipt.
  await vi.waitFor(() =>
    expect(calls("session_prompt_cancel")).toHaveLength(1),
  );
  expect(calls("session_prompt_cancel")[0][1]).toMatchObject({
    connectionId: state.connectionId,
    promptToken: args.promptToken,
    receiptId: 11,
  });
  expect(calls("session_cancel")).toHaveLength(0);
  expect(calls("session_prompt")).toHaveLength(1);
  expect(state.running).toBe(false);
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(state.promptAdmission).not.toBeNull();
  expect(drafts.composerDrafts.read(`session:${state.key}`)).toBe(draft);
});

it("a known ending retires a pre-receipt cancel before its deferred native dispatch", async () => {
  const { request, resolve } = await send();
  await threads.cancel(state.key);
  expect(calls("session_prompt_cancel")).toHaveLength(0);
  event({ kind: "turnEnd", promptReceiptId: 11, stopReason: "cancelled" });
  resolve({ status: "accepted" });
  await request;
  await Promise.resolve();
  expect(calls("session_prompt_cancel")).toHaveLength(0);
  expect(state.running).toBe(false);
  expect(state.connectionOutcomeUnknown).toBe(false);
  expect(state.promptAdmission).toBeNull();
  expect(state.items.filter((item) => item.kind === "settled")).toHaveLength(1);
});
