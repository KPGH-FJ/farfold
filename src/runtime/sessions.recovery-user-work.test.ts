import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult, type ThreadState } from "./sessions";
import { composerDrafts, draftPersistence, draftQueues } from "./drafts";
import type { PromptBlock } from "./session_types";
import { emitOpeningHeader } from "./session_open_test_fixture";

interface OpenArgs {
  channel: { onmessage(event: unknown): void };
  openToken: string;
}

const ready = {
  status: "ready" as const,
  issues: [],
  current: { choices: [] },
};
const text = (value: string): PromptBlock[] => [{ type: "text", text: value }];
const resource: PromptBlock = {
  type: "resource",
  resource: {
    uri: "file:///controlled-only/keep.txt",
    mimeType: "text/plain",
    text: "owned attachment text",
  },
};
let serial = 0;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function seed() {
  const id = `readonly-interleaving-${++serial}`;
  const agentId = "controlled-recovery-fixture";
  const cwd = `/controlled-only/${id}`;
  const state = threads.markOpenFailed(
    `${agentId}:${cwd}:${id}`,
    agentId,
    cwd,
    id,
    "controlled open failure",
  );
  state.items.push({
    kind: "agent",
    id: "old-body",
    text: "existing visible history",
    streaming: false,
    time: 0,
  });
  state.queued = [text("paused later request")];
  state.queuePaused = "stopped";
  state.connectionOutcomeUnknown = false;
  state.stopUnconfirmed = false;
  state.workEnabled = true;
  composerDrafts.update(`session:${state.key}`, () => ({
    text: "new unsent typing",
    attachments: [
      {
        id: "later-attachment",
        kind: "file",
        name: "later.txt",
        uri: "file:///controlled-only/later.txt",
      },
    ],
  }));
  return state;
}
function transport(
  state: ThreadState,
  fail = false,
  historyEvents: unknown[] = [],
) {
  const started = deferred();
  const release = deferred();
  h.invoke.mockImplementation(async (command: string, args: OpenArgs) => {
    if (command === "session_open") {
      const result = {
        cwd: state.cwd,
        nativeSessionId: state.nativeSessionId,
        connectionId: `controlled-connection-${serial}`,
        resumed: true,
        service: null,
        configOptions: [],
        configCheck: ready,
        warnings: [],
      } satisfies OpenResult;
      emitOpeningHeader(args, result);
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "actual replayed history" },
        },
      });
      for (const event of historyEvents) args.channel.onmessage(event);
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      started.resolve();
      await release.promise;
      if (fail) throw new Error("controlled open RPC rejected after prefix");
      return result;
    }
    if (command === "agent_work_get") return { cwd: state.cwd, enabled: {} };
    return command === "settings_get" ? null : [];
  });
  return { started: started.promise, release: release.resolve };
}
function noExecution() {
  expect(
    h.invoke.mock.calls.filter(([command]) =>
      [
        "session_prompt",
        "session_set_config",
        "session_confirm_config",
      ].includes(command),
    ),
  ).toEqual([]);
}
function observe(id: string, state: ThreadState) {
  console.log(
    "CONTROLLED_RECOVERY_OBSERVATION " +
      JSON.stringify({
        id,
        uncertain: state.uncertainPrompt,
        uncertainInQueue: state.uncertainPrompt
          ? state.queued.includes(state.uncertainPrompt)
          : null,
        queued: state.queued,
        queuePaused: state.queuePaused,
        workEnabled: state.workEnabled,
        draft: composerDrafts.read(`session:${state.key}`),
        storedQueue: draftQueues.read(state.key),
        commands: h.invoke.mock.calls.map(([command]) => command),
      }),
  );
}
beforeEach(() => vi.spyOn(draftPersistence, "flush").mockResolvedValue());
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it.each([false, true])(
  "recovery must retain explicit uncertain-copy disposition keep=%s without restoring a dangling blocker",
  async (keep) => {
    const state = seed();
    const unknown = [...text("uncertain original"), resource];
    state.queued.unshift(unknown);
    state.uncertainPrompt = unknown;
    state.queuePaused = "uncertain";
    const oldItems = state.items;
    const later = state.queued[1];
    const ipc = transport(state);
    const opening = threads.reconnect(state.key);
    await ipc.started;
    expect(state.reconnecting).toBe(true);
    expect(state.items).toBe(oldItems);
    composerDrafts.update(`session:${state.key}`, (draft) => ({
      ...draft,
      text: draft.text + " during recovery",
    }));
    threads.abandonUncertainPrompt(state.key, unknown, keep);
    expect(state.uncertainPrompt).toBeNull();
    expect(state.queued).toEqual([later]);
    const currentDraft = structuredClone(
      composerDrafts.read(`session:${state.key}`),
    );
    ipc.release();
    const restored = await opening;
    expect(restored).toBeDefined();
    observe(`uncertain-keep-${keep}`, restored!);
    expect(restored!.queued).toEqual([later]);
    expect(composerDrafts.read(`session:${state.key}`)).toEqual(currentDraft);
    noExecution();
    // This exact user action settled only its saved retry copy, never external work.
    expect(restored!.uncertainPrompt).toBeNull();
    expect(restored!.queuePaused).toBe("stopped");
  },
);

it.each(["recovery", "config-recheck"] as const)(
  "%s must retain a work-location pause saved after its opening header",
  async (mode) => {
    const state = seed();
    if (mode === "config-recheck") {
      state.openError = null;
      state.configCheck = { ...ready, status: "blocked" };
      state.modelDrift = true;
    }
    const originalQueue = state.queued;
    const ipc = transport(state);
    const opening =
      mode === "recovery"
        ? threads.reconnect(state.key)
        : threads.recheckConfig(state.key);
    await ipc.started;
    threads.updateWork(state.cwd, {}, false);
    expect(state.workEnabled).toBe(false);
    expect(state.queuePaused).toBe("work_disabled");
    const currentDraft = structuredClone(
      composerDrafts.read(`session:${state.key}`),
    );
    ipc.release();
    const restored = await opening;
    expect(restored).toBeDefined();
    observe(`work-${mode}`, restored!);
    expect(restored!.queued).toBe(originalQueue);
    expect(composerDrafts.read(`session:${state.key}`)).toEqual(currentDraft);
    noExecution();
    expect(restored!.workEnabled).toBe(false);
    expect(restored!.queuePaused).toBe("work_disabled");
  },
);

it("recovery retains queue edits plus independently typed text and attachment while keeping its pause", async () => {
  const state = seed();
  const ipc = transport(state);
  const opening = threads.reconnect(state.key);
  await ipc.started;
  const original = threads.beginQueueEdit(state.key, 0);
  threads.replaceQueued(state.key, original, [
    ...text("edited while reading history"),
    resource,
  ]);
  composerDrafts.update(`session:${state.key}`, (draft) => ({
    ...draft,
    text: draft.text + " during recovery",
  }));
  const changedQueue = structuredClone(state.queued);
  const changedDraft = structuredClone(
    composerDrafts.read(`session:${state.key}`),
  );
  ipc.release();
  const restored = await opening;
  expect(restored).toBeDefined();
  observe("queue-edit-control", restored!);
  expect(restored!.queued).toEqual(changedQueue);
  expect(composerDrafts.read(`session:${state.key}`)).toEqual(changedDraft);
  expect(restored!.queuePaused).toBe("stopped");
  noExecution();
});

it("a failed recovery retains the current uncertain disposition, typed text, attachments and pause", async () => {
  const state = seed();
  const unknown = [...text("uncertain original"), resource];
  state.queued.unshift(unknown);
  state.uncertainPrompt = unknown;
  state.queuePaused = "uncertain";
  const oldItems = state.items;
  const ipc = transport(state, true);
  const opening = threads.reconnect(state.key);
  await ipc.started;
  threads.abandonUncertainPrompt(state.key, unknown, true);
  threads.updateWork(state.cwd, {}, false);
  const changedQueue = structuredClone(state.queued);
  const changedDraft = structuredClone(
    composerDrafts.read(`session:${state.key}`),
  );
  ipc.release();
  expect(await opening).toBeUndefined();
  expect(threads.thread(state.key)).toBe(state);
  observe("failed-recovery-control", state);
  expect(state.items).toBe(oldItems);
  expect(state.queued).toEqual(changedQueue);
  expect(composerDrafts.read(`session:${state.key}`)).toEqual(changedDraft);
  expect(state.uncertainPrompt).toBeNull();
  expect(state.workEnabled).toBe(false);
  expect(state.queuePaused).toBe("work_disabled");
  noExecution();
});

it("abandoning the retry copy during recovery does not settle unconfirmed external work", async () => {
  const state = seed();
  const unknown = [...text("uncertain original"), resource];
  state.queued.unshift(unknown);
  state.uncertainPrompt = unknown;
  state.queuePaused = "uncertain";
  state.connectionOutcomeUnknown = true;
  state.stopUnconfirmed = true;
  const ipc = transport(state);
  const opening = threads.reconnect(state.key);
  await ipc.started;
  threads.abandonUncertainPrompt(state.key, unknown, false);
  ipc.release();
  const restored = await opening;
  expect(restored).toBeDefined();
  expect(restored!.connectionOutcomeUnknown).toBe(true);
  expect(restored!.stopUnconfirmed).toBe(true);
  expect(restored!.queuePaused).toBe("uncertain");
  noExecution();
  expect(restored!.uncertainPrompt).toBeNull();
});

it("a history turn end still removes only its unknown copy while newer drafts and queued attachments remain paused", async () => {
  const state = seed();
  const unknown = text("uncertain original");
  state.queued.unshift(unknown);
  state.uncertainPrompt = unknown;
  state.queuePaused = "uncertain";
  const invoke = transport(state, false, [
    { kind: "turnEnd", stopReason: "cancelled" },
  ]);
  const opening = threads.reconnect(state.key);
  await invoke.started;
  const edited = [...text("edited later request"), resource];
  threads.replaceQueued(state.key, state.queued[1], edited);
  const changedDraft = structuredClone(
    composerDrafts.read(`session:${state.key}`),
  );
  invoke.release();
  const restored = await opening;
  expect(restored).toBeDefined();
  expect(restored!.uncertainPrompt).toBeNull();
  expect(restored!.queued).toEqual([edited]);
  expect(restored!.queuePaused).toBe("stopped");
  expect(composerDrafts.read(`session:${state.key}`)).toEqual(changedDraft);
  noExecution();
});

it("pause then resume during recovery changes availability without automatically continuing the queue", async () => {
  const state = seed();
  const ipc = transport(state);
  const opening = threads.reconnect(state.key);
  await ipc.started;
  threads.updateWork(state.cwd, {}, false);
  threads.updateWork(state.cwd, {}, true);
  expect(state.workEnabled).toBe(true);
  expect(state.queuePaused).toBe("work_disabled");
  ipc.release();
  const restored = await opening;
  expect(restored).toBeDefined();
  expect(restored!.workEnabled).toBe(true);
  noExecution();
  expect(restored!.queuePaused).toBe("work_disabled");
});
