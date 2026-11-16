import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import { emitOpeningHeader } from "./session_open_test_fixture";
import type { PromptBlock } from "./session_types";

type OpenWire = {
  cwd: string;
  nativeSessionId?: string | null;
  openToken: string;
  channel: { onmessage(event: unknown): void };
  processEndedChannel: { onmessage(event: unknown): void };
};
type PromptWire = {
  sessionId: string;
  connectionId: string;
  admissionChannel: { onmessage(event: unknown): void };
};
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  exitListeners: new Map<string, (event: { payload: number }) => void>(),
  exitHooks: [] as unknown[],
  exitEffects: [] as (() => void | (() => void))[],
  exitCursor: 0,
  settings: new Map<string, unknown>(),
  opens: [] as {
    args: OpenWire;
    sessionId: string;
    connectionId: string;
  }[],
  prompts: [] as { args: PromptWire; receiptId: number }[],
  admission: "accepted" as "accepted" | "unknown",
  pendingAdmission: undefined as
    Promise<{ status: "unknown" | "accepted" }> | undefined,
  pendingRouteClose: undefined as Promise<null> | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));
vi.mock("@tauri-apps/api/event", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/event")>()),
  listen: async (
    name: string,
    callback: (event: { payload: number }) => void,
  ) => {
    h.exitListeners.set(name, callback);
    return () => h.exitListeners.delete(name);
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const i = h.exitCursor++;
    if (i === h.exitHooks.length) h.exitHooks.push(initial);
    return [h.exitHooks[i], (next: unknown) => (h.exitHooks[i] = next)];
  },
  useRef(current: unknown) {
    const i = h.exitCursor++;
    return (h.exitHooks[i] ??= { current });
  },
  useEffect(effect: () => void | (() => void)) {
    h.exitEffects.push(effect);
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
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
  h.pendingAdmission = undefined;
  h.pendingRouteClose = undefined;
  h.exitListeners.clear();
  h.exitHooks = [];
  h.exitEffects = [];
  runtimes.length = 0;
  h.invoke.mockReset().mockImplementation(async (command: string, args) => {
    if (command === "settings_get")
      return structuredClone(h.settings.get(args.key) ?? null);
    if (command === "settings_set") {
      h.settings.set(args.key, structuredClone(args.value));
      return;
    }
    if (command === "agent_work_get") return { cwd: args.cwd };
    if (command === "session_close") return h.pendingRouteClose ?? null;
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
      if (h.pendingAdmission) return h.pendingAdmission;
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

function openRetained(runtime: Runtime, sessionId = nativeId) {
  return runtime.threads.open({ ...input, nativeSessionId: sessionId });
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
  return reloadPersisted(previous, sessionId);
}

async function reloadPersisted(previous: Runtime, sessionId = nativeId) {
  expect(h.settings.has("unsentWork.v1")).toBe(true);
  // Only the serialized settings value crosses this boundary. In particular,
  // no old ThreadState, channel, prompt owner or native lease is transferred.
  h.settings = structuredClone(h.settings);
  vi.resetModules();
  const runtime = await loadRuntime();
  expect(runtime.threads).not.toBe(previous.threads);
  expect(runtime.threads.getSnapshot().threads.size).toBe(0);
  const state = await openRetained(runtime, sessionId);
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

function buttonByText(
  node: ReactNode,
  label: string,
): (() => void) | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child))
      continue;
    if (child.type === "button" && child.props.children === label)
      return child.props.onClick;
    const nested = buttonByText(child.props.children, label);
    if (nested) return nested;
  }
}

async function mountExitProbe() {
  const { DraftStartup } = await import("../components/DraftStartup");
  const { EXIT_IMPACT } = await import("./exit_impact");
  const render = () => {
    h.exitCursor = 0;
    return DraftStartup({ children: null });
  };
  let saved: typeof h.settings | undefined;
  const baseInvoke = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) => {
    if (command === "app_exit_after_save") saved = structuredClone(h.settings);
    return baseInvoke(command, args);
  });
  render();
  const cleanup = h.exitEffects.splice(0).map((effect) => effect());
  return {
    ready: () =>
      vi.waitFor(() =>
        expect(h.exitListeners.has("app:exit-deferred")).toBe(true),
      ),
    button: (label: "stay" | "exit") =>
      buttonByText(render(), EXIT_IMPACT[label]),
    saved: () => saved,
    dispose: () => cleanup.forEach((dispose) => dispose?.()),
  };
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

it("restores a known-unsent queue when its exact process ends during local preparation", async () => {
  const original = await loadRuntime();
  const a = await openRetained(original);
  const otherId = "independent-preparation-conversation";
  const b = await original.threads.open({ ...input, nativeSessionId: otherId });
  const aKey = `session:${a.key}`;
  const bKey = `session:${b.key}`;
  const aDraft = { text: "Separate A editor draft", attachments: [] };
  const bDraft = { text: "Separate B editor draft", attachments: [] };
  original.drafts.composerDrafts.update(aKey, () => aDraft);
  original.drafts.composerDrafts.update(bKey, () => bDraft);
  const unsent = blocks("Queued A input still being checked");
  const owner = h.opens.find((open) => open.connectionId === a.connectionId)!;
  const { archiveActivity } = await import("./archive_activity");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begin = archiveActivity.begin;
  const preparation = vi
    .spyOn(archiveActivity, "begin")
    .mockImplementationOnce(async (key) => {
      await begin(key);
      await held;
    });
  const sending = original.threads.send(a.key, unsent);
  try {
    await vi.waitFor(() => expect(preparation).toHaveBeenCalledOnce());
    expect(a.submitting).toBe(true);
    expect(a.promptAdmission ?? null).toBeNull();
    expectNoColdDispatch(0);

    owner.args.processEndedChannel.onmessage({
      connectionId: owner.connectionId,
      closeReason: "unexpected",
    });
    expect(a.processEndedConnectionId).toBe(owner.connectionId);
    expect(a.connectionLost).toBe(true);
    expect(b.connectionLost).toBe(false);
    expect.soft(a.connectionOutcomeUnknown).toBe(false);
    expect.soft(a.uncertainPrompt).toBeNull();

    // A successful save while preparation remains held must already record
    // definite non-delivery. The pending local action may never resume.
    await original.drafts.draftPersistence.flush();
    const saved = h.settings.get("unsentWork.v1");
    expect.soft(saved).toMatchObject({
      composers: { [aKey]: aDraft, [bKey]: bDraft },
      queues: { [a.key]: { blocks: [unsent], uncertainIndex: null } },
    });
    expect.soft(saved).not.toHaveProperty(["queues", a.key, "outcomeUnknown"]);
  } finally {
    release();
    await sending;
    preparation.mockRestore();
  }
  expect(await sending).toEqual({ status: "rejected", reason: "unavailable" });

  const cold = await coldLoad(original);
  const coldB = await cold.threads.open({ ...input, nativeSessionId: otherId });
  expect(cold.drafts.composerDrafts.read(aKey)).toMatchObject(aDraft);
  expect(cold.drafts.composerDrafts.read(bKey)).toMatchObject(bDraft);
  expect(coldB.historicalOutcomeUnknown).toBe(false);
  expect(coldB.queued).toEqual([]);
  expect(cold.state.queued).toEqual([unsent]);
  expect(cold.state.queuePaused).toBe("stopped");
  expect(cold.state.uncertainPrompt).toBeNull();
  expectNoColdDispatch(0);
  expect(cold.state.historicalOutcomeUnknown).toBe(false);
});

it("still quarantines a prompt already in IPC when its exact process ends before admission", async () => {
  const original = await loadRuntime();
  const hot = await openRetained(original);
  const owner = h.opens.find((open) => open.connectionId === hot.connectionId)!;
  const pending = blocks("Request awaiting its native admission receipt");
  let finish!: () => void;
  h.pendingAdmission = new Promise((resolve) => {
    finish = () => resolve({ status: "unknown" });
  });
  const sending = original.threads.send(hot.key, pending);
  try {
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        "session_prompt",
        expect.objectContaining({ connectionId: owner.connectionId }),
      ),
    );
    expect(hot.promptAdmission?.phase).toBe("preparing");
    expect(hot.running).toBe(false);
    owner.args.processEndedChannel.onmessage({
      connectionId: owner.connectionId,
      closeReason: "unexpected",
    });
    expect(hot.processEndedConnectionId).toBe(owner.connectionId);
    expect(hot.connectionOutcomeUnknown).toBe(true);
    expect(hot.uncertainPrompt).toBe(pending);
    await original.drafts.draftPersistence.flush();
    expect(h.settings.get("unsentWork.v1")).toMatchObject({
      queues: {
        [hot.key]: {
          blocks: [pending],
          uncertainIndex: 0,
          outcomeUnknown: true,
        },
      },
    });
  } finally {
    finish();
    await sending;
    h.pendingAdmission = undefined;
  }
  expect(await sending).toEqual({ status: "unknown" });

  const cold = await coldLoad(original);
  expect(cold.state.historicalOutcomeUnknown).toBe(true);
  expect(cold.state.uncertainPrompt).toEqual(pending);
  expect(cold.state.queuePaused).toBe("uncertain");
  expectNoColdDispatch(1);
});

it.each(["cold only", "warm then cold", "closed route then cold"] as const)(
  "keeps only the next unsent input if a matched ending beats route retirement and the invoke reply (%s)",
  async (recovery) => {
    const original = await loadRuntime();
    const fresh = recovery === "warm then cold";
    const hot = await original.threads.open(
      fresh ? input : { ...input, nativeSessionId: nativeId },
    );
    expect(hot.identity).toBe(fresh ? "draft" : "established");
    const owner = h.opens.find(
      (open) => open.connectionId === hot.connectionId,
    )!;
    const delivered = blocks("Already delivered by the original invocation");
    // Store callers may queue the same input object a second time deliberately.
    const next = delivered;
    const tail = blocks("Independent unsent follow-up");
    let finish!: () => void;
    h.pendingAdmission = new Promise((resolve) => {
      finish = () => resolve({ status: "unknown" });
    });
    const sending = original.threads.send(hot.key, delivered);
    try {
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
      expect(await original.threads.send(hot.key, next)).toEqual({
        status: "queued",
      });
      expect(await original.threads.send(hot.key, tail)).toEqual({
        status: "queued",
      });
      const prompt = h.prompts[0];
      prompt.args.admissionChannel.onmessage({
        receiptId: prompt.receiptId,
        phase: "offered",
      });
      owner.args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Matched Agent reply" },
        },
      });
      ending({ stopReason: "end_turn" });
      expect(hot.items.at(-1)).toMatchObject({
        kind: "settled",
        status: "done",
      });
      expect(hot.submitting).toBe(true);
      expect(hot.promptAdmission).toBeNull();
      expect(hot.queued).toEqual([delivered, next, tail]);
      await original.drafts.draftPersistence.flush();
      const remaining = [next, tail];
      const savedQueue = { blocks: remaining, uncertainIndex: null };
      expect
        .soft(h.settings.get("unsentWork.v1"))
        .toHaveProperty(["queues", hot.key], savedQueue);

      if (recovery === "closed route then cold") {
        owner.args.channel.onmessage({ kind: "deliveryUnavailable" });
        expect(hot.sourceError).toBe(true);
        expect(hot.connectionLost).toBe(false);
        expect(hot.queued).toEqual([delivered, next, tail]);
      } else {
        owner.args.processEndedChannel.onmessage({
          connectionId: owner.connectionId,
          closeReason: "unexpected",
        });
        expect(hot.processEndedConnectionId).toBe(owner.connectionId);
        expect(hot.connectionOutcomeUnknown).toBe(false);
        expect.soft(hot.identity).toBe("established");
        expect.soft(hot.queued).toEqual(remaining);
      }
      if (recovery !== "cold only") {
        const recoveryStarted = h.invoke.mock.calls.length;
        const replacement = await original.threads.reconnect(hot.key);
        expect(replacement).toBeDefined();
        expect(replacement).not.toBe(hot);
        expect(replacement!.connectionId).not.toBe(owner.connectionId);
        expect.soft(replacement!.queued).toEqual(remaining);
        if (recovery === "closed route then cold") {
          const recoveryCalls = h.invoke.mock.calls.slice(recoveryStarted);
          expect(
            recoveryCalls.filter(([name]) =>
              ["session_close", "session_open"].includes(name),
            ),
          ).toEqual([
            [
              "session_close",
              expect.objectContaining({
                agentId: hot.agentId,
                cwd: hot.cwd,
                sessionId: hot.nativeSessionId,
              }),
            ],
            [
              "session_open",
              expect.objectContaining({ nativeSessionId: nativeId }),
            ],
          ]);
          expect(hot.processEndedConnectionId).toBeUndefined();
          expect(replacement!.processEndedConnectionId).toBeUndefined();
        }
      }
      await original.drafts.draftPersistence.flush();
      expect
        .soft(h.settings.get("unsentWork.v1"))
        .toHaveProperty(["queues", hot.key], savedQueue);

      const cold = await reloadPersisted(original);
      expect(cold.state.queued).toEqual(remaining);
      expect(cold.state.queuePaused).toBe("stopped");
      expect(cold.state.uncertainPrompt).toBeNull();
      expect(cold.state.historicalOutcomeUnknown).toBe(false);
      expectNoColdDispatch(1);
    } finally {
      finish();
      await sending;
      h.pendingAdmission = undefined;
    }
    if (recovery === "cold only")
      expect(await sending).toEqual({ status: "accepted" });
    expect(original.threads.thread(hot.key)?.queued).toEqual([next, tail]);
  },
);

it("quarantines an offered prompt with no observed ending across an acknowledged route close", async () => {
  const original = await loadRuntime();
  const hot = await openRetained(original);
  const owner = h.opens.find((open) => open.connectionId === hot.connectionId)!;
  const pending = blocks("Offered before the renderer lost delivery");
  const next = blocks("Independent unsent follow-up");
  let finishPrompt!: () => void;
  h.pendingAdmission = new Promise((resolve) => {
    finishPrompt = () => resolve({ status: "unknown" });
  });
  let acknowledgeClose!: () => void;
  h.pendingRouteClose = new Promise((resolve) => {
    acknowledgeClose = () => resolve(null);
  });
  const sending = original.threads.send(hot.key, pending);
  let reopening: ReturnType<Runtime["threads"]["reconnect"]> | undefined;
  try {
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    const prompt = h.prompts[0];
    prompt.args.admissionChannel.onmessage({
      receiptId: prompt.receiptId,
      phase: "offered",
    });
    expect(await original.threads.send(hot.key, next)).toEqual({
      status: "queued",
    });
    owner.args.channel.onmessage({ kind: "deliveryUnavailable" });
    expect(hot.running).toBe(true);
    expect(hot.sourceError).toBe(true);
    expect(hot.connectionLost).toBe(false);
    reopening = original.threads.reconnect(hot.key);
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("session_close", {
        agentId: hot.agentId,
        cwd: hot.cwd,
        sessionId: hot.nativeSessionId,
      }),
    );
    expect(h.opens).toHaveLength(1);
    expect(hot.connectionOutcomeUnknown).toBe(false);
    expect(hot.uncertainPrompt).toBeNull();
    // Native close has now confirmed the route was released. The renderer
    // received neither the old prompt's ending nor a process-exit receipt.
    acknowledgeClose();
    const replacement = await reopening;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(hot);
    expect(replacement!.connectionId).not.toBe(owner.connectionId);
    expect(hot.processEndedConnectionId).toBeUndefined();
    expect(replacement!.processEndedConnectionId).toBeUndefined();
    expect(replacement!.connectionOutcomeUnknown).toBe(true);
    expect(replacement!.uncertainPrompt).toBe(pending);
    expect(replacement!.queued).toEqual([pending, next]);
    await original.drafts.draftPersistence.flush();
    const cold = await reloadPersisted(original);
    expect(cold.state.historicalOutcomeUnknown).toBe(true);
    expect(cold.state.queuePaused).toBe("uncertain");
    expect(cold.state.uncertainPrompt).toBe(cold.state.queued[0]);
    expect(cold.state.queued).toEqual([pending, next]);
    expectNoColdDispatch(1);
  } finally {
    acknowledgeClose();
    finishPrompt();
    await Promise.allSettled([reopening, sending]);
  }
  const warm = original.threads.thread(hot.key);
  expect(warm?.uncertainPrompt).toBe(pending);
  expect(warm?.queued).toEqual([pending, next]);
  expectNoColdDispatch(1);
});

it("does not transfer an acknowledged input's uncertainty to a repeated queue item during reconnect", async () => {
  const original = await loadRuntime();
  const hot = await openRetained(original);
  const owner = h.opens.find((open) => open.connectionId === hot.connectionId)!;
  const repeated = blocks("Same input deliberately queued a second time");
  const tail = blocks("Independent unsent follow-up");
  let acknowledgePrompt!: () => void;
  h.pendingAdmission = new Promise((resolve) => {
    acknowledgePrompt = () => resolve({ status: "accepted" });
  });
  let openingStarted!: () => void;
  const opening = new Promise<void>((resolve) => {
    openingStarted = resolve;
  });
  let releaseOpening!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseOpening = resolve;
  });
  const invoke = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (command: string, args) => {
    const result = await invoke(command, args);
    if (command === "session_open" && h.opens.length === 2) {
      openingStarted();
      await held;
    }
    return result;
  });
  const sending = original.threads.send(hot.key, repeated);
  let reopening: ReturnType<Runtime["threads"]["reconnect"]> | undefined;
  try {
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(await original.threads.send(hot.key, repeated)).toEqual({
      status: "queued",
    });
    expect(await original.threads.send(hot.key, tail)).toEqual({
      status: "queued",
    });
    owner.args.channel.onmessage({ kind: "deliveryUnavailable" });
    reopening = original.threads.reconnect(hot.key);
    await opening;
    expect(hot.uncertainPrompt).toBe(repeated);
    expect(hot.queued).toEqual([repeated, repeated, tail]);

    acknowledgePrompt();
    expect(await sending).toEqual({ status: "accepted" });
    expect(hot.uncertainPrompt).toBeNull();
    expect(hot.queued).toEqual([repeated, tail]);
    releaseOpening();

    const replacement = await reopening;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(hot);
    expect(replacement!.queued).toEqual([repeated, tail]);
    expect.soft(replacement!.uncertainPrompt).toBeNull();
    expect(replacement!.connectionOutcomeUnknown).toBe(true);
    await original.drafts.draftPersistence.flush();
    const cold = await reloadPersisted(original);
    expect(cold.state.queued).toEqual([repeated, tail]);
    expect.soft(cold.state.uncertainPrompt).toBeNull();
    expect(cold.state.historicalOutcomeUnknown).toBe(true);
    expectNoColdDispatch(1);
  } finally {
    acknowledgePrompt();
    releaseOpening();
    await Promise.allSettled([sending, reopening]);
  }
});

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

it.each(["success", "failure"] as const)(
  "saves queued input as known unsent when confirmed exit overtakes its local file check (%s)",
  async (late) => {
    const original = await loadRuntime();
    const a = await openRetained(original);
    const aKey = `session:${a.key}`;
    const bKey = "session:independent-file-check-at-quit";
    const aDraft = { text: "A editor draft", attachments: [] };
    const bDraft = { text: "B editor draft", attachments: [] };
    original.drafts.composerDrafts.update(aKey, () => aDraft);
    original.drafts.composerDrafts.update(bKey, () => bDraft);
    const uri = "file:///owned-cold-outcome/local.txt";
    const queued = blocks("Queued with local file still being checked");
    queued.push({
      type: "resource",
      resource: { uri, mimeType: "text/plain", text: "原文件文字" },
    });
    const before = structuredClone(queued);
    let release!: () => void;
    const read = new Promise<void>((resolve) => (release = resolve));
    const baseInvoke = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (command, args) => {
      if (command === "draft_attachment_check") {
        await read;
        if (late === "failure") throw { code: "unreadable" };
        return "复核读到的新文件文字";
      }
      if (command === "app_exit_after_save" && late === "success")
        throw new Error("fixture native exit failed");
      return baseInvoke(command, args);
    });
    const exit = await mountExitProbe();
    const { archiveActivity } = await import("./archive_activity");
    const archive = vi.spyOn(archiveActivity, "begin");
    const sending = original.threads.send(a.key, queued);
    try {
      const check = { uri, embed: true };
      await vi.waitFor(() =>
        expect(h.invoke).toHaveBeenCalledWith("draft_attachment_check", check),
      );
      await exit.ready();
      expect(a.promptSubmission?.dispatched).toBe(false);
      h.exitListeners.get("app:save-before-exit")!({ payload: 63 });
      expect(original.drafts.draftQueues.read(a.key)?.uncertainIndex).toBe(0);
      expect(exit.saved()).toBeUndefined();
      exit.button("exit")!();
      await vi.waitFor(() =>
        expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", {
          token: 63,
          confirmActivity: true,
        }),
      );
      const saved = {
        composers: { [aKey]: aDraft, [bKey]: bDraft },
        queues: { [a.key]: { blocks: [before], uncertainIndex: null } },
      };
      expect.soft(exit.saved()?.get("unsentWork.v1")).toMatchObject(saved);
      await vi.waitFor(() =>
        expect(
          original.drafts.draftPersistence.snapshot().interactionLocked,
        ).toBe(late === "failure"),
      );
      release();
      expect((await sending).status).toBe("rejected");
      expect.soft(a.queued).toEqual([before]);
      expect.soft(a.queuePaused).toBe("stopped");
      expect.soft(a.submitting).toBe(false);
      expect.soft(a.items.some((item) => item.kind === "notice")).toBe(false);
      expect.soft(archive).not.toHaveBeenCalled();
      expect
        .soft(h.settings.get("unsentWork.v1"))
        .toEqual(exit.saved()?.get("unsentWork.v1"));
      h.settings = exit.saved()!;
      const cold = await reloadPersisted(original);
      expect.soft(cold.state.queued).toEqual([before]);
      expect.soft(cold.state.queuePaused).toBe("stopped");
      expect.soft(cold.state.uncertainPrompt).toBeNull();
      expect(cold.state.historicalOutcomeUnknown).toBe(false);
      expect(cold.drafts.composerDrafts.read(bKey)).toMatchObject(bDraft);
      expectNoColdDispatch(0);
    } finally {
      release();
      await sending;
      archive.mockRestore();
      exit.dispose();
    }
  },
);

it("preserves an admitted, unfinished owned tool through confirmed exit when cold replay omits it", async () => {
  const original = await loadRuntime();
  const a = await original.threads.open(input);
  const otherId = "independent-quit-conversation";
  const b = await original.threads.open({ ...input, nativeSessionId: otherId });
  const aKey = `session:${a.key}`;
  const bKey = `session:${b.key}`;
  const aDraft = { text: "Unsent A input", attachments: [] };
  const bDraft = { text: "Unsent B input", attachments: [] };
  original.drafts.composerDrafts.update(aKey, () => aDraft);
  original.drafts.composerDrafts.update(bKey, () => bDraft);
  expect(
    await original.threads.send(b.key, blocks("Finished B request")),
  ).toEqual({ status: "accepted" });
  expect(original.drafts.draftQueues.read(b.key)?.outcomeUnknown).toBe(true);
  const bWire = h.opens.find((open) => open.connectionId === b.connectionId)!
    .args.channel;
  const bTool = "owned-b-tool";
  bWire.onmessage({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: bTool,
      title: "B tool",
      status: "in_progress",
    },
  });
  bWire.onmessage({ kind: "toolActivity", toolCallIds: [bTool] });
  ending({ stopReason: "end_turn" });
  expect(b.running).toBe(false);
  expect(original.drafts.draftQueues.read(b.key)?.outcomeUnknown).toBe(true);
  bWire.onmessage({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: bTool,
      status: "completed",
    },
  });
  bWire.onmessage({ kind: "toolActivity", toolCallIds: [] });
  expect(original.drafts.draftQueues.read(b.key)).toBeNull();
  expect(
    await original.threads.send(a.key, blocks("Admitted A request")),
  ).toEqual({ status: "accepted" });
  const toolCallId = "owned-live-tool-at-quit";
  const wire = h.opens.find((open) => open.connectionId === a.connectionId)!
    .args.channel;
  wire.onmessage({
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Unfinished A tool",
      status: "in_progress",
    },
  });
  wire.onmessage({ kind: "toolActivity", toolCallIds: [toolCallId] });
  expect(a).toMatchObject({
    running: true,
    submitting: false,
    activeToolCallIds: [toolCallId],
    queued: [],
    uncertainPrompt: null,
    connectionOutcomeUnknown: false,
  });
  expect(a.items.some((item) => item.kind === "settled")).toBe(false);

  const exit = await mountExitProbe();
  try {
    await exit.ready();
    h.exitListeners.get("app:save-before-exit")!({ payload: 61 });
    const stay = exit.button("stay");
    expect(stay).toBeDefined();
    expect(exit.saved()).toBeUndefined();
    stay!();
    await vi.waitFor(() =>
      expect(
        original.drafts.draftPersistence.snapshot().interactionLocked,
      ).toBe(false),
    );
    expect(h.invoke).toHaveBeenCalledWith("app_exit_cancel", { token: 61 });
    expect(a.running).toBe(true);
    expect(a.connectionOutcomeUnknown).toBe(false);
    expect(a.historicalOutcomeUnknown).toBe(false);
    expectNoColdDispatch(2);

    h.exitListeners.get("app:save-before-exit")!({ payload: 62 });
    const confirm = exit.button("exit");
    expect(confirm).toBeDefined();
    expect(exit.saved()).toBeUndefined();
    expect(a.connectionOutcomeUnknown).toBe(false);
    expect(a.historicalOutcomeUnknown).toBe(false);
    expect(original.drafts.draftQueues.read(b.key)?.outcomeUnknown).not.toBe(
      true,
    );
    confirm!();
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        "app_exit_after_save",
        expect.objectContaining({ token: 62, confirmActivity: true }),
      ),
    );
    const unsent = exit.saved()?.get("unsentWork.v1");
    expect.soft(unsent).toMatchObject({
      composers: { [aKey]: aDraft, [bKey]: bDraft },
      queues: {
        [a.key]: { blocks: [], uncertainIndex: null, outcomeUnknown: true },
      },
    });
    expect.soft(unsent).not.toHaveProperty(["queues", b.key]);

    h.settings = exit.saved()!;
    const cold = await reloadPersisted(original);
    expect(cold.state.items.some((item) => item.kind === "tool")).toBe(false);
    expect(cold.state.queued).toEqual([]);
    expect(cold.state.uncertainPrompt).toBeNull();
    const coldB = await openRetained(cold, otherId);
    expect(coldB.historicalOutcomeUnknown).toBe(false);
    expectNoColdDispatch(2);
    expect(cold.state.historicalOutcomeUnknown).toBe(true);
  } finally {
    exit.dispose();
  }
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
    event: "exact process ended",
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
    const other = await openRetained(original, otherId);
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
    const owner = h.opens.find(
      (open) => open.connectionId === hot.connectionId,
    )!;
    const wire = owner.args.channel;
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
    } else if (event === "exact process ended") {
      const otherOwner = h.opens.find(
        (open) => open.connectionId === other.connectionId,
      )!;
      const receipt = {
        connectionId: owner.connectionId,
        closeReason: "unexpected",
      };
      owner.args.processEndedChannel.onmessage({
        ...receipt,
        connectionId: otherOwner.connectionId,
      });
      otherOwner.args.processEndedChannel.onmessage(receipt);
      expect(hot.processEndedConnectionId).toBeUndefined();
      expect(hot.connectionLost).toBe(false);
      expect(hot.connectionOutcomeUnknown).toBe(false);
      expect(other.processEndedConnectionId).toBeUndefined();
      expect(other.connectionLost).toBe(false);

      // Malformed terminal values cannot rewrite this still-unfinished step,
      // including after the exact process really ends.
      for (const bad of [
        { toolCallId: Number(toolCallId), status: "completed" },
        { toolCallId, status: ["failed"] },
      ]) {
        const update = { sessionUpdate: "tool_call_update", ...bad };
        const envelope = { update };
        wire.onmessage(envelope);
        expect
          .soft(hot.items.at(-1))
          .toMatchObject({ kind: "raw", update: envelope });
      }

      // The typed process-owner channel can arrive without a tool terminal or
      // a normal event-channel disconnect. End ownership, not the tool result.
      owner.args.processEndedChannel.onmessage(receipt);
      expect(hot.processEndedConnectionId).toBe(owner.connectionId);
      expect(hot.connectionLost).toBe(true);
      expect(hot.connectionOutcomeUnknown).toBe(true);
      expect(hot.items.find((item) => item.kind === "tool")).toMatchObject({
        call: { toolCallId, status: "pending" },
      });
      expect(other.processEndedConnectionId).toBeUndefined();
      expect(other.connectionLost).toBe(false);
      expect(other.connectionOutcomeUnknown).toBe(false);
      expect(other.queued).toEqual([]);
      await original.drafts.draftPersistence.flush();
      expect(h.settings.get("unsentWork.v1")).toMatchObject({
        queues: {
          [hot.key]: {
            blocks: [pending],
            uncertainIndex: null,
            outcomeUnknown: true,
          },
        },
      });
      expect(
        h.invoke.mock.calls.filter(([name]) => name === "session_close"),
      ).toEqual([]);
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
        // A malformed ID is still visible as raw evidence without touching
        // the original tool or retiring its active ID.
        expect(hot.items.find((item) => item.kind === "tool")).toMatchObject({
          call: { toolCallId, status: "pending" },
        });
        expect(hot.items.at(-1)).toMatchObject({
          kind: "raw",
          update: {
            update: { toolCallId: Number(toolCallId), status: "completed" },
          },
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
    const coldOther = await openRetained(cold, otherId);
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
  const b = await openRetained(original, "separate-owned-conversation");
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
  const coldB = await openRetained(cold, b.nativeSessionId);
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

it("protects an unopened conversation with a saved unknown outcome from archive and deletion", async () => {
  const key = `${input.agentId}:${input.cwd}:${nativeId}`;
  const sibling = `${key}-sibling`;
  const previous = await loadRuntime();
  const { archiveActivity } = await import("./archive_activity");
  await archiveActivity.finish(key);
  await archiveActivity.finish(sibling);
  previous.drafts.draftQueues.write(key, [], null, true);
  await previous.drafts.draftPersistence.flush();
  vi.resetModules();
  const runtime = await loadRuntime();
  const { archiveEligible } = await import("./auto_archive");
  const row = {
    ...input,
    id: key,
    nativeSessionId: nativeId,
    title: null,
    configOptions: null,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const afterDeadline = Date.now() + 2 * 86_400_000;
  expect(runtime.threads.thread(key)).toBeUndefined();
  expect(runtime.threads.archiveBlockReason(key)).toBe("unconfirmed");
  expect(runtime.threads.archiveBlockReason(sibling)).toBeNull();
  expect(archiveEligible(row, undefined, 1, afterDeadline)).toBe(false);
  expect(
    archiveEligible({ ...row, id: sibling }, undefined, 1, afterDeadline),
  ).toBe(true);
  await expect(runtime.threads.setArchived(key, true)).rejects.toThrow();
  await expect(
    runtime.threads.delete({ ...input, id: key, nativeSessionId: nativeId }),
  ).rejects.toThrow();
  expect(h.invoke.mock.calls.map(([command]) => command)).not.toContain(
    "session_meta_archive",
  );
  expect(h.invoke.mock.calls.map(([command]) => command)).not.toContain(
    "session_delete",
  );
  const opened = await openRetained(runtime);
  expect(runtime.threads.archiveBlockReason(key)).not.toBeNull();
  runtime.threads.acknowledgeHistoricalOutcome(opened);
  expect(runtime.threads.archiveBlockReason(key)).toBeNull();
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
  const current = await openRetained(cold);
  expect(current).not.toBe(cold.state);
  expect(current.historicalOutcomeUnknown).toBe(true);
  cold.threads.acknowledgeHistoricalOutcome(cold.state);
  expect(current.historicalOutcomeUnknown).toBe(true);
  expect(cold.threads.needsAttention(current)).toBe(true);
  expectNoColdDispatch(1);
});
