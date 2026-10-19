import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  opens: [] as {
    args: Record<string, any>;
    connectionId: string;
    sessionId: string;
  }[],
  early: false,
  reuseSessionId: null as string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));
let threads: typeof import("./sessions").threads;
let controller: import("./agent_preparation").AgentPreparation;
let drafts: typeof import("./drafts");
const input = {
  agentId: "owned-ended-recovery",
  agentName: "Example",
  cwd: "/owned-ended-recovery",
  program: "selected-owned-program",
  service: null,
};
beforeEach(async () => {
  vi.resetModules();
  h.opens = [];
  h.early = false;
  h.reuseSessionId = null;
  h.invoke.mockReset().mockImplementation(async (command: string, args) => {
    if (command === "settings_get") return null;
    if (command === "session_open") {
      const number = h.opens.length + 1;
      const row = {
        args,
        connectionId: `owned-connection-${number}`,
        sessionId: h.reuseSessionId ?? `owned-session-${number}`,
      };
      h.opens.push(row);
      if (h.early)
        args.processEndedChannel.onmessage({
          connectionId: row.connectionId,
          closeReason: "unexpected",
        });
      return {
        cwd: args.cwd,
        nativeSessionId: row.sessionId,
        connectionId: row.connectionId,
        resumed: false,
        configOptions: [],
        configCheck: { status: "ready", issues: [], current: { choices: [] } },
      };
    }
    if (command === "session_prompt") {
      const row = h.opens.find(
        (item) =>
          item.sessionId === args.sessionId &&
          item.connectionId === args.connectionId,
      )!;
      args.admissionChannel.onmessage({ receiptId: 11, phase: "offered" });
      row.args.channel.onmessage({
        kind: "turnEnd",
        promptReceiptId: 11,
        error: "AUTH_REQUIRED",
      });
      return { status: "accepted" };
    }
    if (command === "session_index_list") return [];
    return [];
  });
  drafts = await import("./drafts");
  await drafts.draftPersistence.load();
  threads = (await import("./sessions")).threads;
  const { AgentPreparation } = await import("./agent_preparation");
  controller = new AgentPreparation(threads, () => "owned-ended-recovery");
});
afterEach(async () => {
  controller.invalidate(false);
  await drafts.draftPersistence.flush();
});
async function failedRequest() {
  await controller.prepare(input);
  await controller.start();
  const state = threads.thread(controller.getSnapshot().threadKey!)!;
  expect(controller.getSnapshot().phase).toBe("failed");
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(controller.canPrepare()).toBe(false);
  return state;
}
function close(index = 0) {
  const row = h.opens[index];
  row.args.processEndedChannel.onmessage({
    connectionId: row.connectionId,
    closeReason: "unexpected",
  });
}
const calls = (name: string) =>
  h.invoke.mock.calls.filter(([command]) => command === name);
it("raw close homonyms and ordinary loss never authorize recovery", async () => {
  const old = await failedRequest();
  h.opens[0].args.channel.onmessage({
    sessionId: old.nativeSessionId,
    kind: "connectionLost",
    connectionId: old.connectionId,
    processEnded: true,
    closeReason: "unexpected",
  });
  h.opens[0].args.channel.onmessage({
    sessionId: old.nativeSessionId,
    update: {
      kind: "processEnded",
      connectionId: old.connectionId,
      processEnded: true,
    },
  });
  await controller.prepare(input, true);
  expect(controller.canPrepare()).toBe(false);
  expect(old.processEndedConnectionId).toBeUndefined();
  expect(old.connectionOutcomeUnknown).toBe(true);
  expect(calls("session_open")).toHaveLength(1);
  expect(calls("session_prompt")).toHaveLength(1);
});
it("actual local process closure permits only explicit fresh preparation and keeps old uncertainty", async () => {
  const old = await failedRequest();
  const items = [...old.items];
  const draft = drafts.composerDrafts.read(`session:${old.key}`);
  close();
  expect(old.connectionLost).toBe(true);
  expect(old.processEndedConnectionId).toBe(old.connectionId);
  expect(old.connectionOutcomeUnknown).toBe(true);
  expect(old.items).toEqual(items);
  expect(controller.canPrepare()).toBe(true);
  await controller.prepare(input);
  expect(calls("session_open")).toHaveLength(1);
  await controller.prepare(input, true);
  const fresh = threads.thread(controller.getSnapshot().threadKey!)!;
  expect(controller.getSnapshot().phase).toBe("untested");
  expect(fresh).not.toBe(old);
  expect(fresh.connectionId).not.toBe(old.connectionId);
  expect(fresh.processEndedConnectionId).toBeUndefined();
  expect(threads.thread(old.key)).toBe(old);
  expect(old.connectionOutcomeUnknown).toBe(true);
  expect(drafts.composerDrafts.read(`session:${old.key}`)).toBe(draft);
  expect(calls("session_prompt")).toHaveLength(1);
});
it("old closure cannot retire a newer preparation or supply a new connection's proof", async () => {
  const old = await failedRequest();
  close();
  await controller.prepare(input, true);
  const fresh = threads.thread(controller.getSnapshot().threadKey!)!;
  const snapshot = controller.getSnapshot();
  close();
  expect(threads.thread(fresh.key)).toBe(fresh);
  expect(controller.getSnapshot()).toBe(snapshot);
  expect(fresh.connectionLost).toBe(false);
  expect(fresh.processEndedConnectionId).toBeUndefined();
  expect(old.connectionOutcomeUnknown).toBe(true);
  expect(calls("session_open")).toHaveLength(2);
});
it("early receipt is buffered once and never publishes a usable closed read", async () => {
  h.early = true;
  await controller.prepare(input);
  const state = threads.thread(controller.getSnapshot().threadKey!)!;
  expect(state.processEndedConnectionId).toBe(state.connectionId);
  expect(state.connectionLost).toBe(true);
  expect(controller.getSnapshot().phase).toBe("failed");
  expect(calls("session_open")).toHaveLength(1);
  expect(calls("session_prompt")).toHaveLength(0);
});
it("wrong connection and malformed control-channel values cannot release a live unknown request", async () => {
  const old = await failedRequest();
  for (const value of [
    { connectionId: "old-foreign", closeReason: "unexpected" },
    { connectionId: old.connectionId, closeReason: "unexpected", update: null },
    { connectionId: old.connectionId, closeReason: "future_reason" },
  ]) {
    h.opens[0].args.processEndedChannel.onmessage(value);
  }
  expect(controller.canPrepare()).toBe(false);
  expect(old.processEndedConnectionId).toBeUndefined();
  close();
  expect(controller.canPrepare()).toBe(true);
});

it("a late old process receipt cannot change a real same-key replacement with a new connection", async () => {
  const old = await failedRequest();
  const oldChannel = h.opens[0].args.processEndedChannel;
  // A mixed loss may precede the independently delivered local receipt.
  // An explicit open can already publish a replacement route in that interval.
  h.opens[0].args.channel.onmessage({ kind: "connectionLost" });
  h.reuseSessionId = old.nativeSessionId;
  const fresh = await threads.open({
    agentId: input.agentId,
    cwd: input.cwd,
    fresh: true,
  });
  expect(fresh.key).toBe(old.key);
  expect(fresh).not.toBe(old);
  expect(fresh.connectionId).not.toBe(old.connectionId);
  const snapshot = controller.getSnapshot();
  const items = [...fresh.items];
  const priorUnknown = fresh.connectionOutcomeUnknown;
  oldChannel.onmessage({
    connectionId: old.connectionId,
    closeReason: "unexpected",
  });
  expect(threads.thread(old.key)).toBe(fresh);
  expect(fresh.processEndedConnectionId).toBeUndefined();
  expect(fresh.connectionLost).toBe(false);
  expect(fresh.connectionOutcomeUnknown).toBe(priorUnknown);
  expect(fresh.items).toEqual(items);
  expect(controller.getSnapshot()).toBe(snapshot);
  expect(old.connectionOutcomeUnknown).toBe(true);
  expect(calls("session_open")).toHaveLength(2);
  expect(calls("session_prompt")).toHaveLength(1);
});

it("process end during actual first-send persistence cannot bypass local pending preparation or account guards", async () => {
  await controller.prepare(input);
  const state = threads.thread(controller.getSnapshot().threadKey!)!;
  drafts.composerDrafts.update(`session:${state.key}`, () => ({
    text: "Keep local pending draft",
    attachments: [],
  }));
  const draft = drafts.composerDrafts.read(`session:${state.key}`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flush = vi
    .spyOn(drafts.draftPersistence, "flush")
    .mockImplementationOnce(() => held);
  const sending = controller.start();
  let sampled:
    | {
        submitting: boolean;
        cannotPrepare: boolean;
        keyUnchanged: boolean;
        accountRejected: boolean;
        openCalls: number;
        promptCalls: number;
      }
    | undefined;
  try {
    await vi.waitFor(() => expect(flush).toHaveBeenCalled());
    close();
    const submitting = state.submitting;
    const cannotPrepare = !controller.canPrepare();
    await controller.prepare(input, true);
    const keyUnchanged = controller.getSnapshot().threadKey === state.key;
    const accountRejected = await Promise.resolve()
      .then(() =>
        controller.prepareForAccount({
          agentId: input.agentId,
          cwd: input.cwd,
        }),
      )
      .then(
        () => false,
        () => true,
      );
    sampled = {
      submitting,
      cannotPrepare,
      keyUnchanged,
      accountRejected,
      openCalls: calls("session_open").length,
      promptCalls: calls("session_prompt").length,
    };
  } finally {
    // Always release the real pending send before asserting the negative;
    // a regression must not leave a mocked local save or request suspended.
    release();
    await sending;
    flush.mockRestore();
  }
  expect(sampled).toEqual({
    submitting: true,
    cannotPrepare: true,
    keyUnchanged: true,
    accountRejected: true,
    openCalls: 1,
    promptCalls: 0,
  });
  expect(state.processEndedConnectionId).toBe(state.connectionId);
  expect(state.submitting).toBe(false);
  expect(drafts.composerDrafts.read(`session:${state.key}`)).toBe(draft);
  expect(calls("session_prompt")).toHaveLength(0);
  await controller.prepare(input, true);
  const fresh = threads.thread(controller.getSnapshot().threadKey!)!;
  expect(controller.getSnapshot().phase).toBe("untested");
  expect(fresh).not.toBe(state);
  expect(fresh.connectionId).not.toBe(state.connectionId);
  expect(calls("session_open")).toHaveLength(2);
  expect(calls("session_prompt")).toHaveLength(0);
});
