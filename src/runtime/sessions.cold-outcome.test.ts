import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emitOpeningHeader } from "./session_open_test_fixture";
import type { PromptBlock } from "./session_types";

type OpenWire = {
  cwd: string;
  nativeSessionId?: string | null;
  openToken: string;
  channel: { onmessage(event: unknown): void };
};
type PromptWire = {
  sessionId: string;
  connectionId: string;
  admissionChannel: { onmessage(event: unknown): void };
};
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  settings: new Map<string, unknown>(),
  opens: [] as {
    args: OpenWire;
    sessionId: string;
    connectionId: string;
  }[],
  prompts: [] as { args: PromptWire; receiptId: number }[],
  admission: "accepted" as "accepted" | "unknown",
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));

const input = {
  agentId: "owned-cold-outcome",
  program: "owned-test-program",
  cwd: "/owned-cold-outcome",
  service: null,
};
const nativeId = "owned-native-conversation";
const officialHistory = "Official retained history, not a completion receipt";
const blocks = (text: string): PromptBlock[] => [{ type: "text", text }];
type Runtime = {
  drafts: typeof import("./drafts");
  threads: typeof import("./sessions").threads;
};
const runtimes: Runtime[] = [];

beforeEach(() => {
  vi.resetModules();
  h.settings = new Map();
  h.opens = [];
  h.prompts = [];
  h.admission = "accepted";
  runtimes.length = 0;
  h.invoke.mockReset().mockImplementation(async (command: string, args) => {
    if (command === "settings_get")
      return structuredClone(h.settings.get(args.key) ?? null);
    if (command === "settings_set") {
      h.settings.set(args.key, structuredClone(args.value));
      return;
    }
    if (command === "session_open") {
      const wire = args as OpenWire;
      const row = {
        args: wire,
        sessionId: wire.nativeSessionId ?? nativeId,
        connectionId: `owned-connection-${h.opens.length + 1}`,
      };
      h.opens.push(row);
      const result = {
        cwd: wire.cwd,
        nativeSessionId: row.sessionId,
        connectionId: row.connectionId,
        resumed: Boolean(wire.nativeSessionId),
        service: null,
        configOptions: [],
        configCheck: { status: "ready", issues: [], current: { choices: [] } },
      };
      emitOpeningHeader(wire, result);
      if (result.resumed) {
        wire.channel.onmessage({
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: officialHistory },
          },
        });
        wire.channel.onmessage({
          kind: "session_history_complete",
          openToken: wire.openToken,
        });
      }
      return result;
    }
    if (command === "session_prompt") {
      const wire = args as PromptWire;
      const receiptId = 41 + h.prompts.length;
      h.prompts.push({ args: wire, receiptId });
      wire.admissionChannel.onmessage({ receiptId, phase: "offered" });
      return { status: h.admission };
    }
    return command === "session_index_list" ? [] : null;
  });
});

afterEach(async () => {
  for (const runtime of runtimes) await runtime.drafts.draftPersistence.flush();
});

async function loadRuntime(): Promise<Runtime> {
  const drafts = await import("./drafts");
  await drafts.draftPersistence.load();
  const threads = (await import("./sessions")).threads;
  const runtime = { drafts, threads };
  runtimes.push(runtime);
  return runtime;
}

function ending(value: Record<string, unknown>): void {
  const prompt = h.prompts.at(-1)!;
  const opened = h.opens.find(
    (row) => row.connectionId === prompt.args.connectionId,
  )!;
  opened.args.channel.onmessage({
    kind: "turnEnd",
    promptReceiptId: prompt.receiptId,
    ...value,
  });
}

async function coldLoad(previous: Runtime, sessionId = nativeId) {
  previous.threads.pauseQueuesForExit();
  await previous.drafts.draftPersistence.flush();
  expect(h.settings.has("unsentWork.v1")).toBe(true);
  // Only the serialized settings value crosses this boundary. In particular,
  // no old ThreadState, channel, prompt owner or native lease is transferred.
  h.settings = structuredClone(h.settings);
  vi.resetModules();
  const runtime = await loadRuntime();
  expect(runtime.threads).not.toBe(previous.threads);
  expect(runtime.threads.getSnapshot().threads.size).toBe(0);
  const state = await runtime.threads.open({
    ...input,
    nativeSessionId: sessionId,
  });
  expect(state.nativeSessionId).toBe(sessionId);
  expect(state.resumed).toBe(true);
  expect(state.openError).toBeNull();
  expect(state.historyUnavailable).toBeNull();
  expect(state.running).toBe(false);
  expect(state.stopping).toBe(false);
  expect(state.promptAdmission ?? null).toBeNull();
  expect(state.items.filter((item) => item.kind === "user")).toMatchObject([
    { text: officialHistory },
  ]);
  expect(
    state.items.some(
      (item) =>
        item.kind === "settled" &&
        (item.status === "done" || item.status === "stopped"),
    ),
  ).toBe(false);
  return { ...runtime, state };
}

function expectNoColdDispatch(promptCount: number): void {
  expect(h.prompts).toHaveLength(promptCount);
  expect(
    h.invoke.mock.calls.filter(([command]) =>
      [
        "session_cancel",
        "session_prompt_cancel",
        "session_set_config",
        "session_set_mode",
      ].includes(command),
    ),
  ).toEqual([]);
}

it("preserves an accepted empty-queue unknown outcome across a complete cold rebuild without reviving the old live owner", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  expect(
    await original.threads.send(hot.key, blocks("Owned uncertain input")),
  ).toEqual({ status: "accepted" });
  expect(hot.queued).toEqual([]);
  ending({ error: "AUTH_REQUIRED" });
  expect(hot.connectionOutcomeUnknown).toBe(true);
  expect(hot.uncertainPrompt).toBeNull();
  expect(hot.queued).toEqual([]);
  expect(original.threads.needsAttention(hot)).toBe(true);

  const cold = await coldLoad(original);
  expect(cold.state).not.toBe(hot);
  expect(cold.state.connectionId).not.toBe(hot.connectionId);
  expect(cold.state.queued).toEqual([]);
  expect(cold.state.uncertainPrompt).toBeNull();
  expectNoColdDispatch(1);
  // User-visible outcome memory, not a requirement to keep a dead process busy
  // or to implement a particular persisted field/second execution ledger.
  expect(cold.threads.needsAttention(cold.state)).toBe(true);
});

it("does not invent cold uncertainty after an owned finite ending", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  await original.threads.send(hot.key, blocks("Owned completed input"));
  h.opens[0].args.channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Owned finite answer" },
    },
  });
  ending({ stopReason: "end_turn" });
  expect(hot.connectionOutcomeUnknown).toBe(false);
  expect(hot.queued).toEqual([]);

  const cold = await coldLoad(original);
  expect(cold.threads.needsAttention(cold.state)).toBe(false);
  expect(cold.state.connectionOutcomeUnknown).toBe(false);
  expectNoColdDispatch(1);
});

it("keeps the existing queued-uncertain cold recovery path paused without resending", async () => {
  h.admission = "unknown";
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  const pending = blocks("Owned possibly delivered input");
  expect(await original.threads.send(hot.key, pending)).toEqual({
    status: "unknown",
  });
  expect(hot.uncertainPrompt).toBe(pending);

  const cold = await coldLoad(original);
  expect(cold.state.queued).toEqual([pending]);
  expect(cold.state.uncertainPrompt).toBe(cold.state.queued[0]);
  expect(cold.state.queuePaused).toBe("uncertain");
  expect(cold.threads.needsAttention(cold.state)).toBe(true);
  expectNoColdDispatch(1);
});

it("does not treat an ordinary unsent draft's unfinished archive metadata as an unknown dispatched request", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  original.drafts.composerDrafts.update(`session:${hot.key}`, () => ({
    text: "Owned never-sent draft",
    attachments: [],
  }));
  await original.drafts.draftPersistence.flush();
  const snapshot = h.settings.get("unsentWork.v1") as {
    activity: Record<string, { ended: boolean }>;
  };
  expect(snapshot.activity[hot.key].ended).toBe(false);

  const cold = await coldLoad(original);
  expect(cold.drafts.composerDrafts.read(`session:${hot.key}`).text).toBe(
    "Owned never-sent draft",
  );
  expect(cold.threads.needsAttention(cold.state)).toBe(false);
  expect(cold.state.connectionOutcomeUnknown).toBe(false);
  expectNoColdDispatch(0);
});

it("does not transfer the old unknown result to a different official conversation", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  await original.threads.send(hot.key, blocks("Owned uncertain input"));
  ending({ error: "AUTH_REQUIRED" });
  expect(hot.connectionOutcomeUnknown).toBe(true);

  const cold = await coldLoad(original, "different-owned-native-conversation");
  expect(cold.state.nativeSessionId).not.toBe(hot.nativeSessionId);
  expect(cold.threads.needsAttention(cold.state)).toBe(false);
  expectNoColdDispatch(1);
});

it("allows the same hot owner finite ending to clear a notice that has not been cold restored", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  await original.threads.send(hot.key, blocks("Owned uncertain input"));
  ending({ error: "AUTH_REQUIRED" });
  await original.drafts.draftPersistence.flush();
  expect(original.drafts.draftQueues.read(hot.key)?.outcomeUnknown).toBe(true);
  expect(hot.historicalOutcomeUnknown).toBe(false);
  ending({ stopReason: "end_turn" });
  expect(hot.connectionOutcomeUnknown).toBe(false);
  const cold = await coldLoad(original);
  expect(cold.state.historicalOutcomeUnknown).toBe(false);
  expect(cold.threads.needsAttention(cold.state)).toBe(false);
  expectNoColdDispatch(1);
});

it("keeps the cold historical notice through a new successful request and another official cold load", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  await original.threads.send(hot.key, blocks("Owned uncertain input"));
  ending({ error: "AUTH_REQUIRED" });
  const cold = await coldLoad(original);
  expect(cold.state.historicalOutcomeUnknown).toBe(true);
  expect(cold.state.connectionOutcomeUnknown).toBe(false);
  expect(cold.state.stopUnconfirmed).toBe(false);
  expect(cold.state.queuePaused).toBeNull();
  const { configChangeBusy } = await import("./protected_config");
  expect(configChangeBusy(cold.state)).toBe(false);
  expect(
    await cold.threads.send(cold.state.key, blocks("New explicit input")),
  ).toEqual({
    status: "accepted",
  });
  ending({ stopReason: "end_turn" });
  expect(cold.state.connectionOutcomeUnknown).toBe(false);
  expect(cold.state.historicalOutcomeUnknown).toBe(true);
  const next = await coldLoad(cold);
  expect(next.state.historicalOutcomeUnknown).toBe(true);
  expect(next.threads.needsAttention(next.state)).toBe(true);
  expectNoColdDispatch(2);
});

it("acknowledges only the historical notice synchronously while new live uncertainty wins persistence", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  await original.threads.send(hot.key, blocks("Owned uncertain input"));
  ending({ error: "AUTH_REQUIRED" });
  const cold = await coldLoad(original);
  await cold.threads.send(cold.state.key, blocks("New explicit input"));
  ending({ error: "OTHER_FAILURE" });
  cold.state.stopUnconfirmed = true;
  const queue = cold.state.queued;
  const pause = cold.state.queuePaused;
  const calls = h.invoke.mock.calls.length;
  expect(cold.threads.acknowledgeHistoricalOutcome(cold.state)).toBeUndefined();
  expect(cold.state.historicalOutcomeUnknown).toBe(false);
  expect(cold.state.connectionOutcomeUnknown).toBe(true);
  expect(cold.state.stopUnconfirmed).toBe(true);
  expect(cold.state.queued).toBe(queue);
  expect(cold.state.queuePaused).toBe(pause);
  expect(cold.threads.needsAttention(cold.state)).toBe(true);
  // No asynchronous acknowledgement or request is scheduled by this action.
  expect(
    h.invoke.mock.calls.slice(calls).every(([name]) => name === "settings_set"),
  ).toBe(true);
  const next = await coldLoad(cold);
  expect(next.state.historicalOutcomeUnknown).toBe(true);
  expect(next.state.connectionOutcomeUnknown).toBe(false);
  expectNoColdDispatch(2);
});

it("persists an idle historical acknowledgement without inventing any request outcome", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  await original.threads.send(hot.key, blocks("Owned uncertain input"));
  ending({ error: "AUTH_REQUIRED" });
  const cold = await coldLoad(original);
  cold.threads.acknowledgeHistoricalOutcome(cold.state);
  expect(cold.state.historicalOutcomeUnknown).toBe(false);
  expect(cold.threads.needsAttention(cold.state)).toBe(false);
  const next = await coldLoad(cold);
  expect(next.state.historicalOutcomeUnknown).toBe(false);
  expect(next.threads.needsAttention(next.state)).toBe(false);
  expectNoColdDispatch(1);
});

it("persists new uncertainty that arrives after acknowledging the older notice", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  await original.threads.send(hot.key, blocks("Owned uncertain input"));
  ending({ error: "AUTH_REQUIRED" });
  const cold = await coldLoad(original);
  await cold.threads.send(cold.state.key, blocks("New explicit input"));
  cold.threads.acknowledgeHistoricalOutcome(cold.state);
  expect(cold.state.historicalOutcomeUnknown).toBe(false);
  ending({ error: "NEW_FAILURE" });
  expect(cold.state.connectionOutcomeUnknown).toBe(true);
  const next = await coldLoad(cold);
  expect(next.state.historicalOutcomeUnknown).toBe(true);
  expectNoColdDispatch(2);
});

it("retains an unconfirmed stop as a historical notice without restoring live stopping state", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  // The finite UI stop flag is persisted independently of an admission copy.
  hot.stopUnconfirmed = true;
  const cold = await coldLoad(original);
  expect(cold.state.historicalOutcomeUnknown).toBe(true);
  expect(cold.state.stopUnconfirmed).toBe(false);
  expect(cold.state.connectionOutcomeUnknown).toBe(false);
  expect(cold.state.stopping).toBe(false);
  expectNoColdDispatch(0);
});

it("does not let a stale pre-reconnect view acknowledge a newer owner", async () => {
  const original = await loadRuntime();
  const hot = await original.threads.open(input);
  await original.threads.send(hot.key, blocks("Owned uncertain input"));
  ending({ error: "AUTH_REQUIRED" });
  const cold = await coldLoad(original);
  // An ended connection allows the real open/replay path to replace its view.
  cold.state.connectionLost = true;
  const current = await cold.threads.open({
    ...input,
    nativeSessionId: nativeId,
  });
  expect(current).not.toBe(cold.state);
  expect(current.historicalOutcomeUnknown).toBe(true);
  cold.threads.acknowledgeHistoricalOutcome(cold.state);
  expect(current.historicalOutcomeUnknown).toBe(true);
  expect(cold.threads.needsAttention(current)).toBe(true);
  expectNoColdDispatch(1);
});
