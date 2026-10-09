import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { threads, type PromptBlock } from "./sessions";
import { draftPersistence, draftQueues } from "./drafts";
import { archiveActivity } from "./archive_activity";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  invoke.mockImplementation(async (command: string) =>
    command === "session_prompt"
      ? { status: "accepted" }
      : command === "session_index_list"
        ? []
        : null,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  invoke.mockReset();
});

it.each(
  ["attachment", "draft-save", "activity-save"].flatMap((stage) =>
    (["draft", "established"] as const).map(
      (identity) => [stage, identity] as const,
    ),
  ),
)(
  "stops during %s for a %s conversation without a phantom Agent cancellation",
  async (stage, identity) => {
    const id = `cancel-before-dispatch-${stage}-${identity}`;
    const state = threads.markOpenFailed(
      `a:/p:${id}`,
      "a",
      "/p",
      id,
      "fixture",
    );
    state.openError = null;
    state.identity = identity;
    const reached = deferred();
    const release = deferred();
    const wait = async () => {
      reached.resolve();
      await release.promise;
    };
    if (stage === "attachment") {
      invoke.mockImplementation(async (command: string) => {
        if (command === "draft_attachment_check") await wait();
        return command === "session_prompt"
          ? { status: "accepted" }
          : command === "session_index_list"
            ? []
            : null;
      });
    } else if (stage === "draft-save") {
      vi.mocked(draftPersistence.flush).mockImplementationOnce(wait);
    } else {
      vi.mocked(archiveActivity.begin).mockImplementationOnce(wait);
    }
    const first: PromptBlock[] = [
      { type: "text", text: "Keep original" },
      { type: "resource_link", name: "Original", uri: "file:///original.txt" },
    ];
    const next: PromptBlock[] = [{ type: "text", text: "Keep later input" }];
    const sending = threads.send(state.key, first);
    await reached.promise;
    expect(state.submitting).toBe(true);
    await threads.send(state.key, next);
    await threads.cancel(state.key);
    release.resolve();
    const admission = await sending;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(admission.status).toBe("rejected");
    expect(state).toMatchObject({
      running: false,
      submitting: false,
      stopping: false,
      stopUnconfirmed: false,
      connectionOutcomeUnknown: false,
      uncertainPrompt: null,
      queuePaused: "stopped",
      queued: [first, next],
      identity,
    });
    expect(state.items).toEqual([]);
    expect(draftQueues.read(state.key)?.uncertainIndex).toBeNull();
    expect(
      invoke.mock.calls.filter(([command]) =>
        ["session_prompt", "session_cancel"].includes(command),
      ),
    ).toEqual([]);

    // Cancelling preparation preserves input; only this explicit action sends it.
    await threads.continueQueue(state.key);
    const prompts = invoke.mock.calls.filter(
      ([command]) => command === "session_prompt",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0][1].content).toEqual(first);
    expect(state.queued).toEqual([next]);
    expect(state.running).toBe(true);
  },
);

it("still requests an Agent stop after dispatch while admission is pending", async () => {
  const id = "cancel-after-dispatch-before-admission";
  const state = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  state.openError = null;
  const dispatched = deferred();
  const admit = deferred();
  invoke.mockImplementation(async (command: string) => {
    if (command === "session_prompt") {
      dispatched.resolve();
      await admit.promise;
      return { status: "accepted" };
    }
    return command === "session_index_list" ? [] : null;
  });
  const sending = threads.send(state.key, [
    { type: "text", text: "Dispatched" },
  ]);
  await dispatched.promise;
  await threads.cancel(state.key);
  expect(invoke).toHaveBeenCalledWith("session_cancel", {
    agentId: "a",
    cwd: "/p",
    sessionId: id,
  });
  expect(state.stopping).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(state.stopUnconfirmed).toBe(true);
  admit.resolve();
  expect(await sending).toEqual({ status: "accepted" });
  expect(state.stopUnconfirmed).toBe(true);
  expect(state.running).toBe(true);
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(state.key, { kind: "turnEnd", stopReason: "cancelled" });
  expect(state.running).toBe(false);
  expect(state.stopUnconfirmed).toBe(false);
  expect(state.queuePaused).toBe("stopped");
});

it.each([false, true])(
  "retires a stop when prompt admission is explicitly rejected (cancel reply fails: %s)",
  async (cancelFails) => {
    const id = `cancel-rejected-admission-${cancelFails}`;
    const state = threads.markOpenFailed(
      `a:/p:${id}`,
      "a",
      "/p",
      id,
      "fixture",
    );
    state.openError = null;
    const dispatched = deferred();
    const rejectAdmission = deferred();
    invoke.mockImplementation(async (command: string) => {
      if (command === "session_prompt") {
        dispatched.resolve();
        await rejectAdmission.promise;
        return { status: "rejected", reason: "work_disabled" };
      }
      if (command === "session_cancel" && cancelFails)
        throw new Error("Cancellation reply unavailable");
      return command === "session_index_list" ? [] : null;
    });
    const first: PromptBlock[] = [{ type: "text", text: "Never admitted" }];
    const next: PromptBlock[] = [{ type: "text", text: "Keep later input" }];
    const sending = threads.send(state.key, first);
    await dispatched.promise;
    await threads.send(state.key, next);
    await threads.cancel(state.key);
    rejectAdmission.resolve();
    expect(await sending).toEqual({
      status: "rejected",
      reason: "work_disabled",
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(state).toMatchObject({
      running: false,
      submitting: false,
      stopping: false,
      stopUnconfirmed: false,
      connectionOutcomeUnknown: false,
      uncertainPrompt: null,
      queuePaused: "work_disabled",
      queued: [first, next],
    });
    expect(state.items).toEqual([]);
  },
);

it.each(["unknown", "lost-reply"])(
  "keeps execution protection when stopping overlaps %s admission",
  async (outcome) => {
    const id = `cancel-uncertain-admission-${outcome}`;
    const state = threads.markOpenFailed(
      `a:/p:${id}`,
      "a",
      "/p",
      id,
      "fixture",
    );
    state.openError = null;
    const dispatched = deferred();
    const settleAdmission = deferred();
    invoke.mockImplementation(async (command: string) => {
      if (command === "session_prompt") {
        dispatched.resolve();
        await settleAdmission.promise;
        if (outcome === "lost-reply") throw new Error("IPC reply lost");
        return { status: "unknown" };
      }
      return command === "session_index_list" ? [] : null;
    });
    const first: PromptBlock[] = [
      { type: "text", text: "Possibly dispatched" },
    ];
    const next: PromptBlock[] = [{ type: "text", text: "Keep later input" }];
    const sending = threads.send(state.key, first);
    await dispatched.promise;
    await threads.send(state.key, next);
    await threads.cancel(state.key);
    settleAdmission.resolve();
    expect(await sending).toEqual({ status: "unknown" });
    expect(state.stopping).toBe(true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(state).toMatchObject({
      running: false,
      submitting: false,
      stopping: false,
      stopUnconfirmed: true,
      connectionOutcomeUnknown: true,
      uncertainPrompt: first,
      queuePaused: "uncertain",
      queued: [first, next],
    });
    await threads.continueQueue(state.key);
    expect(state.queued).toEqual([first, next]);
    expect(
      invoke.mock.calls.filter(([command]) => command === "session_prompt"),
    ).toHaveLength(1);
  },
);
