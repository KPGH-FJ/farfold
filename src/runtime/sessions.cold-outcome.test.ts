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
    if (command === "agent_work_get") return { cwd: args.cwd };
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

it.each([
  {
    event: "no terminal",
    priorUnknown: false,
    hasQueue: true,
    expectUnknown: true,
  },
  {
    event: "no terminal",
    priorUnknown: false,
    hasQueue: false,
    expectUnknown: true,
  },
  {
    event: "different terminal",
    priorUnknown: false,
    hasQueue: true,
    expectUnknown: true,
  },
  {
    event: "malformed terminal",
    priorUnknown: false,
    hasQueue: true,
    expectUnknown: true,
  },
  {
    event: "agent-shaped activity",
    priorUnknown: false,
    hasQueue: true,
    expectUnknown: true,
  },
  {
    event: "newer prompt",
    priorUnknown: false,
    hasQueue: true,
    expectUnknown: true,
  },
  {
    event: "matching terminal",
    priorUnknown: false,
    hasQueue: true,
    expectUnknown: false,
  },
  {
    event: "matching terminal",
    priorUnknown: true,
    hasQueue: true,
    expectUnknown: true,
  },
])(
  "cold restores stopped-tool results with $event, queued $hasQueue, and prior unknown $priorUnknown only in their own conversation",
  async ({ event, priorUnknown, hasQueue, expectUnknown }) => {
    let original = await loadRuntime();
    let hot = await original.threads.open(input);
    if (priorUnknown) {
      await original.threads.send(hot.key, blocks("Earlier unknown request"));
      ending({ error: "AUTH_REQUIRED" });
      const restored = await coldLoad(original);
      original = restored;
      hot = restored.state;
      expect(hot.historicalOutcomeUnknown).toBe(true);
    }
    const otherId = "other-owned-native-conversation";
    const other = await original.threads.open({
      ...input,
      nativeSessionId: otherId,
    });
    const pending = blocks("Wait here for explicit continuation");
    const draftKey = `session:${hot.key}`;
    const otherDraftKey = `session:${other.key}`;
    original.drafts.composerDrafts.update(draftKey, () => ({
      text: "Exact original draft",
      attachments: [],
    }));
    original.drafts.composerDrafts.update(otherDraftKey, () => ({
      text: "Other draft",
      attachments: [],
    }));
    expect(
      await original.threads.send(hot.key, blocks("Starts the stopped tool")),
    ).toEqual({ status: "accepted" });
    if (hasQueue && event !== "newer prompt")
      expect(await original.threads.send(hot.key, pending)).toEqual({
        status: "queued",
      });
    const toolCallId = "7";
    const wire = h.opens.find((open) => open.connectionId === hot.connectionId)!
      .args.channel;
    wire.onmessage({
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Pending exact tool",
        kind: "execute",
        status: "pending",
      },
    });
    wire.onmessage({
      kind: "toolActivity",
      toolCallIds: [toolCallId],
    });
    ending({ stopReason: "cancelled" });
    expect(hot.items.at(-1)).toMatchObject({
      kind: "settled",
      status: "stopped",
      stopReason: "cancelled",
    });
    expect(hot.activeToolCallIds).toEqual([toolCallId]);
    expect(hot.queuePaused).toBe("stopped");
    expect(hot.connectionOutcomeUnknown).toBe(false);

    if (event === "newer prompt") {
      expect(
        await original.threads.send(hot.key, blocks("New explicit request")),
      ).toEqual({ status: "accepted" });
      expect(await original.threads.send(hot.key, pending)).toEqual({
        status: "queued",
      });
      expect(hot.activeToolCallIds).toEqual([toolCallId]);
    } else if (event === "agent-shaped activity") {
      const impostor = {
        sessionId: hot.nativeSessionId,
        kind: "toolActivity",
        toolCallIds: [],
      };
      // The router must keep the original session/update envelope even if it
      // omits its update object. It is not a locally generated work receipt.
      wire.onmessage(impostor);
      expect(hot.activeToolCallIds).toEqual([toolCallId]);
      expect(hot.items.at(-1)).toMatchObject({
        kind: "raw",
        update: impostor,
      });
    } else if (
      event === "different terminal" ||
      event === "malformed terminal" ||
      event === "matching terminal"
    ) {
      await original.drafts.draftPersistence.flush();
      wire.onmessage({
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId:
            event === "matching terminal"
              ? toolCallId
              : event === "malformed terminal"
                ? Number(toolCallId)
                : "unrelated-tool",
          status: "completed",
        },
      });
      if (event === "matching terminal")
        wire.onmessage({ kind: "toolActivity", toolCallIds: [] });
      if (event === "malformed terminal") {
        // A tolerant display parser stringifies the ID; the owning backend's
        // real activity still includes the pending step.
        expect(hot.items.find((item) => item.kind === "tool")).toMatchObject({
          call: { toolCallId, status: "completed" },
        });
        expect(hot.activeToolCallIds).toEqual([toolCallId]);
      }
    }

    const cold = await coldLoad(original);
    expect(cold.state.items.some((item) => item.kind === "tool")).toBe(false);
    expect(cold.state.activeToolCallIds).toEqual([]);
    expect(cold.state.historicalOutcomeUnknown).toBe(expectUnknown);
    expect(cold.threads.needsAttention(cold.state)).toBe(expectUnknown);
    expect(cold.state.queued).toEqual(hasQueue ? [pending] : []);
    expect(cold.state.uncertainPrompt).toBeNull();
    expect(cold.state.queuePaused).toBe(hasQueue ? "stopped" : null);
    expect(cold.drafts.composerDrafts.read(draftKey).text).toBe(
      "Exact original draft",
    );
    const coldOther = await cold.threads.open({
      ...input,
      nativeSessionId: otherId,
    });
    expect(coldOther.historicalOutcomeUnknown).toBe(false);
    expect(cold.threads.needsAttention(coldOther)).toBe(false);
    expect(coldOther.queued).toEqual([]);
    expect(cold.drafts.composerDrafts.read(otherDraftKey).text).toBe(
      "Other draft",
    );
    expectNoColdDispatch(
      1 + Number(priorUnknown) + Number(event === "newer prompt"),
    );
  },
);

it("saves the exact stopped work before closing and restores it after a cold open that omits the tool", async () => {
  const original = await loadRuntime();
  const a = await original.threads.open(input);
  const b = await original.threads.open({
    ...input,
    nativeSessionId: "separate-owned-conversation",
  });
  const draftKey = `session:${a.key}`;
  const attachment = {
    id: "owned-stopped-draft-file",
    kind: "file" as const,
    name: "retained.txt",
    uri: "file:///owned-cold-outcome/retained.txt",
    deliveryMode: "location" as const,
  };
  const draft = { text: "Original unsent draft", attachments: [attachment] };
  const editedDraft = { ...draft, text: "Last edit before closing" };
  const queued = blocks("Original paused input");
  original.drafts.composerDrafts.update(draftKey, () => draft);
  original.drafts.composerDrafts.update(`session:${b.key}`, () => ({
    text: "Other unsent draft",
    attachments: [],
  }));
  await expect(
    original.threads.send(a.key, blocks("Owned first request")),
  ).resolves.toEqual({
    status: "accepted",
  });
  await expect(original.threads.send(a.key, queued)).resolves.toEqual({
    status: "queued",
  });
  const toolCallId = "stopped-without-terminal";
  const wire = h.opens.find((open) => open.connectionId === a.connectionId)!
    .args.channel;
  wire.onmessage({
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Exact tool",
      status: "pending",
    },
  });
  wire.onmessage({ kind: "toolActivity", toolCallIds: [toolCallId] });
  ending({ stopReason: "cancelled" });
  await expect(
    original.threads.send(b.key, blocks("Independent request")),
  ).resolves.toEqual({
    status: "accepted",
  });

  const { stoppedWorkTarget } = await import("./stopped_work_close");
  const target = stoppedWorkTarget(a)!;
  expect(target).toMatchObject({ sessionId: a.nativeSessionId, toolCallId });
  const proof = {
    connectionId: target.connectionId,
    sessionId: target.sessionId,
    toolCallId,
    proofId: "41",
  };
  const baseInvoke = h.invoke.getMockImplementation()!;
  let finishSave!: () => void;
  const heldSave = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  let saveStarted = false;
  h.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "session_check_unapproved_stopped_close") return proof;
    if (command === "settings_set") {
      const request = args as {
        key: string;
        value?: { composers?: Record<string, { text: string }> };
      };
      if (
        request.key === "unsentWork.v1" &&
        request.value?.composers?.[draftKey]?.text === editedDraft.text
      ) {
        saveStarted = true;
        await heldSave;
      }
    }
    if (command === "session_close_unapproved_stopped") {
      expect(args).toEqual({ ...proof, agentId: a.agentId, cwd: a.cwd });
      // The storage response must already include the original stopped tool's
      // uncertainty and input before a close can remove the live owner.
      expect(h.settings.get("unsentWork.v1")).toMatchObject({
        composers: { [draftKey]: editedDraft },
        queues: {
          [a.key]: {
            blocks: [queued],
            uncertainIndex: null,
            outcomeUnknown: true,
          },
        },
      });
      return proof;
    }
    return baseInvoke(command, args);
  });
  await expect(
    original.threads.checkStoppedWorkClose(a, target),
  ).resolves.toEqual(proof);
  let closing: Promise<void> | undefined;
  try {
    original.drafts.composerDrafts.update(draftKey, () => editedDraft);
    await vi.waitFor(() => expect(saveStarted).toBe(true));
    expect(h.settings.get("unsentWork.v1")).toMatchObject({
      composers: { [draftKey]: draft },
    });
    closing = original.threads.closeStoppedWork(a, target, proof);
    await Promise.resolve();
    expect(
      h.invoke.mock.calls.filter(
        ([cmd]) => cmd === "session_close_unapproved_stopped",
      ),
    ).toHaveLength(0);
  } finally {
    finishSave();
    await closing;
  }
  expect(a.historicalOutcomeUnknown).toBe(true);
  expect(b.running).toBe(true);
  expect(b.connectionLost).toBe(false);
  h.opens
    .find((open) => open.connectionId === b.connectionId)!
    .args.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Independent reply" },
      },
    });
  ending({ stopReason: "end_turn" });
  expect(b.running).toBe(false);
  expect(b.items.at(-1)).toMatchObject({ kind: "settled", status: "done" });

  const cold = await coldLoad(original);
  expect(cold.state.items.some((item) => item.kind === "tool")).toBe(false);
  expect(cold.state.historicalOutcomeUnknown).toBe(true);
  expect(cold.state.queued).toEqual([queued]);
  expect(cold.state.queuePaused).toBe("stopped");
  expect(cold.drafts.composerDrafts.read(draftKey)).toMatchObject({
    text: editedDraft.text,
    attachments: [{ ...attachment, recovered: true }],
  });
  const coldB = await cold.threads.open({
    ...input,
    nativeSessionId: b.nativeSessionId,
  });
  expect(coldB.historicalOutcomeUnknown).toBe(false);
  expect(cold.drafts.composerDrafts.read(`session:${coldB.key}`).text).toBe(
    "Other unsent draft",
  );
  expect(
    h.invoke.mock.calls.filter(
      ([cmd]) => cmd === "session_close_unapproved_stopped",
    ),
  ).toHaveLength(1);
  expectNoColdDispatch(2);
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
