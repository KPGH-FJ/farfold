import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { threads, type PromptBlock } from "./sessions";
import { composerDrafts, draftPersistence, draftQueues } from "./drafts";
import { archiveActivity } from "./archive_activity";
import { canReleaseEmptyQueuePause } from "./queue";
import type { ThreadState } from "./session_types";
import { markRestoredQueueAttachments } from "./recovered_attachments";

const channel = threads as unknown as {
  applyChannelEvent(key: string, event: unknown): void;
};
const text = (value: string): PromptBlock[] => [{ type: "text", text: value }];
let serial = 0;
function state() {
  const id = `outcome-${++serial}`;
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  return s;
}
function event(key: string, value: unknown) {
  channel.applyChannelEvent(key, value);
}
function reply(key: string) {
  event(key, {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Reply" },
    },
  });
  event(key, { kind: "turnEnd", stopReason: "end_turn" });
}
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  vi.spyOn(archiveActivity, "touch").mockResolvedValue();
  invoke.mockImplementation(async (command: string) =>
    command === "session_prompt"
      ? { status: "accepted" }
      : command === "settings_get"
        ? null
        : [],
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
});

it("pauses queued input after an empty ending and never records it as completed activity", async () => {
  const s = state();
  await threads.send(s.key, text("First"));
  await threads.send(s.key, text("Second"));
  event(s.key, { kind: "turnEnd", stopReason: "end_turn" });
  expect(s.queuePaused).toBe("no_result");
  expect(s.queued).toEqual([text("Second")]);
  expect(
    invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(1);
  expect(archiveActivity.finish).not.toHaveBeenCalled();
});

it("admits only an explicit new message after a confirmed failure with an empty queue", async () => {
  const s = state();
  await threads.send(s.key, text("Failed request"));
  event(s.key, { kind: "turnEnd", failure: { category: "service" } });
  expect(s).toMatchObject({
    running: false,
    connectionOutcomeUnknown: false,
    queuePaused: "failed",
    queued: [],
  });
  expect(s.items.at(-1)).toMatchObject({ kind: "settled", status: "failed" });
  const failedItems = [...s.items];
  const draftKey = `session:${s.key}`;
  composerDrafts.update(draftKey, () => ({
    text: "Keep later typing",
    attachments: [
      { id: "later", kind: "file", name: "Later", uri: "file:///later.txt" },
    ],
    sendPending: true,
  }));
  const draft = composerDrafts.read(draftKey);
  const generation = composerDrafts.generation(draftKey);
  const canStart = canReleaseEmptyQueuePause(s);
  expect(await threads.send(s.key, text("New request"))).toEqual({
    status: "accepted",
  });
  expect(canStart).toBe(true);
  const calls = invoke.mock.calls.filter(
    ([command]) => command === "session_prompt",
  );
  expect(calls.map(([, args]) => args.content)).toEqual([
    text("Failed request"),
    text("New request"),
  ]);
  expect(s.queuePaused).toBeNull();
  expect(s.queued).toEqual([]);
  expect(s.items.slice(0, failedItems.length)).toEqual(failedItems);
  expect(composerDrafts.read(draftKey)).toBe(draft);
  expect(composerDrafts.generation(draftKey)).toBe(generation);
});

it("keeps an active tool protected after failure and never automatically sends waiting new input", async () => {
  const s = state();
  await threads.send(s.key, text("Failed request"));
  event(s.key, {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tail",
      status: "in_progress",
    },
  });
  event(s.key, { kind: "toolActivity", toolCallIds: ["tail"] });
  event(s.key, { kind: "turnEnd", failure: { category: "service" } });
  expect(s.activeToolCallIds).toEqual(["tail"]);
  expect(canReleaseEmptyQueuePause(s)).toBe(false);
  const next = text("New request");
  expect(await threads.send(s.key, next)).toEqual({ status: "queued" });
  event(s.key, { kind: "toolActivity", toolCallIds: [] });
  expect(s.queuePaused).toBe("failed");
  expect(s.queued).toEqual([next]);
  expect(
    invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(1);
});

const failureAdmissionGuards: [string, Partial<ThreadState>][] = [
  ["unknown execution", { connectionOutcomeUnknown: true }],
  ["uncertain request", { uncertainPrompt: text("Possibly dispatched") }],
  ["configuration in progress", { configuring: true }],
  ["configuration mismatch", { modelDrift: true }],
  [
    "unconfirmed permission",
    { permissionConfigId: "permission", permissionState: "unknown" },
  ],
  ["pending webpage approval", { browserReadRequestId: "approval" }],
  ["unconfirmed stop", { stopUnconfirmed: true }],
  ["connection lost", { connectionLost: true }],
  ["work disabled", { workEnabled: false }],
];
it.each(failureAdmissionGuards)(
  "keeps a failed empty queue paused with %s",
  async (_reason, guard) => {
    const s = state();
    s.queuePaused = "failed";
    Object.assign(s, guard);
    expect(canReleaseEmptyQueuePause(s)).toBe(false);
    const next = text("Keep new input");
    expect(await threads.send(s.key, next)).toEqual({ status: "queued" });
    expect(s.queuePaused).toBe("failed");
    expect(s.queued).toEqual([next]);
    expect(s).toMatchObject(guard);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("retains a failed configuration and its draft instead of admitting new input", async () => {
  const s = state();
  s.queuePaused = "failed";
  s.configError = "fixture";
  const key = `session:${s.key}`;
  composerDrafts.update(key, () => ({ text: "Keep draft", attachments: [] }));
  const draft = composerDrafts.read(key);
  expect(canReleaseEmptyQueuePause(s)).toBe(false);
  await expect(threads.send(s.key, text("New request"))).rejects.toThrow();
  expect(s.queuePaused).toBe("failed");
  expect(s.queued).toEqual([]);
  expect(s.configError).toBe("fixture");
  expect(composerDrafts.read(key)).toBe(draft);
  expect(invoke).not.toHaveBeenCalled();
});

it("retains existing failed input and appends new input without sending either", async () => {
  const s = state();
  const original = text("Never dispatched");
  s.queued = [original];
  s.queuePaused = "failed";
  const next = text("New request");
  expect(canReleaseEmptyQueuePause(s)).toBe(false);
  expect(await threads.send(s.key, next)).toEqual({ status: "queued" });
  expect(s.queuePaused).toBe("failed");
  expect(s.queued).toEqual([original, next]);
  expect(s.queued[0]).toBe(original);
  expect(invoke).not.toHaveBeenCalled();
});

it.each(["uncertain", "unavailable"] as const)(
  "does not release an empty %s pause for a new message",
  async (pause) => {
    const s = state();
    s.queuePaused = pause;
    expect(canReleaseEmptyQueuePause(s)).toBe(false);
    const next = text("New request");
    expect(await threads.send(s.key, next)).toEqual({ status: "queued" });
    expect(s.queuePaused).toBe(pause);
    expect(s.queued).toEqual([next]);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("keeps restored attachments awaiting review when new input follows a failure", async () => {
  const s = state();
  s.queuePaused = "failed";
  const next: PromptBlock[] = [
    ...text("Recovered image"),
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ];
  markRestoredQueueAttachments([next]);
  expect(canReleaseEmptyQueuePause(s, next)).toBe(false);
  expect(await threads.send(s.key, next)).toEqual({ status: "queued" });
  expect(s.queuePaused).toBe("failed");
  expect(s.queued).toEqual([next]);
  expect(invoke).not.toHaveBeenCalled();
});

it.each(["unknown", "lost-reply"])(
  "a real terminal channel receipt beats a late %s admission reply",
  async (kind) => {
    const s = state();
    invoke.mockImplementation(async (command: string) => {
      if (command !== "session_prompt")
        return command === "settings_get" ? null : [];
      reply(s.key);
      if (kind === "lost-reply") throw new Error("IPC reply lost");
      return { status: "unknown" };
    });
    expect(await threads.send(s.key, text("First"))).toEqual({
      status: "accepted",
    });
    expect(s.queued).toEqual([]);
    expect(s.uncertainPrompt).toBeNull();
    expect(s.connectionOutcomeUnknown).toBe(false);
    expect(s.identity).toBe("established");
    expect(archiveActivity.finish).toHaveBeenCalledWith(s.key);
  },
);

it("discarding a hot unknown retry copy does not clear execution protection or consume another queued message", async () => {
  const s = state();
  invoke.mockImplementation(async (command: string) =>
    command === "session_prompt" ? { status: "unknown" } : null,
  );
  const first = text("Possibly dispatched");
  await threads.send(s.key, first);
  const later = text("Never dispatched");
  await threads.send(s.key, later);
  threads.abandonUncertainPrompt(s.key, first, false);
  expect(s.queued).toEqual([later]);
  expect(s.connectionOutcomeUnknown).toBe(true);
  await threads.continueQueue(s.key);
  expect(
    invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(1);
  await threads.cancel(s.key);
  expect(invoke).toHaveBeenCalledWith("session_cancel", {
    agentId: s.agentId,
    cwd: s.cwd,
    sessionId: s.nativeSessionId,
  });
  expect(s.stopping).toBe(true);
  reply(s.key);
  expect(s.connectionOutcomeUnknown).toBe(false);
  expect(s.queued).toEqual([later]);
  expect(s.queuePaused).toBe("stopped");
});

it("cold restored unknown input can be kept with later typing and attachments, while all other messages stay paused", () => {
  const id = `cold-outcome-${++serial}`;
  const key = `a:/p:${id}`;
  const original: PromptBlock[] = [
    ...text("Original"),
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    {
      type: "resource",
      resource: {
        uri: "file:///original.txt",
        mimeType: "text/plain",
        text: "File text",
      },
    },
  ];
  draftQueues.write(key, [original, text("Next")], 0);
  const s = threads.markOpenFailed(key, "a", "/p", id, "fixture");
  s.openError = null;
  composerDrafts.update(`session:${key}`, () => ({
    text: "Later typing",
    attachments: [
      { id: "later", kind: "file", name: "Later", uri: "file:///later.txt" },
    ],
  }));
  const restored = s.uncertainPrompt!;
  threads.abandonUncertainPrompt(key, restored, true);
  expect(composerDrafts.read(`session:${key}`)).toMatchObject({
    text: "Later typing\n\nOriginal",
    attachments: [
      { id: "later" },
      { kind: "image", data: "aW1hZ2U=" },
      { uri: "file:///original.txt", content: "File text" },
    ],
  });
  expect(s.queued).toEqual([text("Next")]);
  expect(s.queuePaused).toBe("stopped");
  expect(s.uncertainPrompt).toBeNull();
  expect(draftQueues.read(key)?.uncertainIndex).toBeNull();
  expect(
    invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("rejects a stale or merely equal retry target and leaves the original content intact", () => {
  const s = state();
  const original = text("Same text");
  s.queued = [original, text("Same text")];
  s.uncertainPrompt = original;
  expect(() =>
    threads.abandonUncertainPrompt(s.key, structuredClone(original), true),
  ).toThrow();
  expect(s.queued).toHaveLength(2);
  s.uncertainPrompt = s.queued[1];
  expect(() =>
    threads.abandonUncertainPrompt(s.key, original, false),
  ).toThrow();
  expect(s.queued[0]).toBe(original);
  expect(composerDrafts.hasContent(`session:${s.key}`)).toBe(false);
});

it("does not dispatch if saving the beginning of activity fails", async () => {
  const s = state();
  vi.mocked(archiveActivity.begin).mockRejectedValueOnce(
    new Error("save failed"),
  );
  expect(await threads.send(s.key, text("Keep me"))).toEqual({
    status: "rejected",
    reason: "failed",
  });
  expect(
    invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(s.queued).toEqual([text("Keep me")]);
});

it("waits for actual dispatch activity to be saved before sending", async () => {
  const s = state();
  const calls: string[] = [];
  vi.mocked(draftPersistence.flush).mockImplementation(async () => {
    calls.push("draft");
  });
  vi.mocked(archiveActivity.begin).mockImplementation(async () => {
    calls.push("begin");
  });
  invoke.mockImplementation(async (command: string) => {
    calls.push(command);
    return { status: "accepted" };
  });
  await threads.send(s.key, text("First"));
  expect(calls.indexOf("draft")).toBeLessThan(calls.indexOf("begin"));
  expect(calls.indexOf("begin")).toBeLessThan(calls.indexOf("session_prompt"));
});

it("records an actual stopped request only after the last live tool ends", () => {
  const s = state();
  s.running = true;
  event(s.key, {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tail",
      status: "in_progress",
    },
  });
  event(s.key, { kind: "toolActivity", toolCallIds: ["tail"] });
  event(s.key, { kind: "turnEnd", stopReason: "cancelled" });
  expect(archiveActivity.finish).not.toHaveBeenCalled();
  event(s.key, {
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tail",
      status: "completed",
    },
  });
  event(s.key, { kind: "toolActivity", toolCallIds: [] });
  expect(archiveActivity.finish).toHaveBeenCalledExactlyOnceWith(s.key);
});

it("never records historical tool replay or process disappearance as a verified ending", () => {
  const s = state();
  event(s.key, {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "history",
      status: "completed",
    },
  });
  event(s.key, { kind: "toolActivity", toolCallIds: [] });
  expect(archiveActivity.finish).not.toHaveBeenCalled();
  s.running = true;
  event(s.key, {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "lost",
      status: "in_progress",
    },
  });
  event(s.key, { kind: "toolActivity", toolCallIds: ["lost"] });
  event(s.key, { kind: "turnEnd", stopReason: "cancelled" });
  event(s.key, {
    kind: "toolActivity",
    toolCallIds: [],
    reason: "process_ended",
  });
  expect(s.connectionOutcomeUnknown).toBe(true);
  expect(archiveActivity.finish).not.toHaveBeenCalled();
});

it("keeps a manual restore unchanged when refreshing its activity cannot be saved", async () => {
  const s = state();
  vi.mocked(archiveActivity.touch).mockRejectedValueOnce(
    new Error("save failed"),
  );
  await expect(threads.setArchived(s.key, false)).rejects.toThrow();
  expect(
    invoke.mock.calls.some(([command]) => command === "session_meta_archive"),
  ).toBe(false);
});
