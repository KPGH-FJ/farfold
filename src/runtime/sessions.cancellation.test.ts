import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { threads, type PromptBlock } from "./sessions";
import { draftPersistence, draftQueues } from "./drafts";
import { archiveActivity } from "./archive_activity";
import type { ThreadState } from "./session_types";
import { PROMPT_ADMISSION as S } from "./prompt_admission_strings";

type PromptArgs = {
  promptToken: string;
  admissionChannel: { onmessage(value: unknown): void };
};
function receipt(args: PromptArgs) {
  return (
    invoke.mock.calls.findIndex(
      ([command, value]) => command === "session_prompt" && value === args,
    ) + 1
  );
}
function offer(args: PromptArgs, phase = "offered") {
  args.admissionChannel.onmessage({ receiptId: receipt(args), phase });
}
function ready(state: ThreadState) {
  state.openError = null;
  state.connectionId = `connection-${state.key}`;
  state.configCheck = { status: "ready", issues: [], current: { choices: [] } };
}
function cancelReply(args: { receiptId: number }) {
  return { receiptId: args.receiptId, outcome: "cancelRequested" };
}

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
  invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_prompt") {
      offer(args);
      return { status: "accepted" };
    }
    return command === "session_index_list" ? [] : null;
  });
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
    ready(state);
    state.identity = identity;
    const reached = deferred();
    const release = deferred();
    const wait = async () => {
      reached.resolve();
      await release.promise;
    };
    if (stage === "attachment") {
      invoke.mockImplementation(async (command: string, args) => {
        if (command === "draft_attachment_check") await wait();
        if (command === "session_prompt") {
          offer(args);
          return { status: "accepted" };
        }
        return command === "session_index_list" ? [] : null;
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
        ["session_prompt", "session_cancel", "session_prompt_cancel"].includes(
          command,
        ),
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
  ready(state);
  const dispatched = deferred();
  const admit = deferred();
  invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_prompt") {
      offer(args);
      dispatched.resolve();
      await admit.promise;
      return { status: "accepted" };
    }
    if (command === "session_prompt_cancel") return cancelReply(args);
    return command === "session_index_list" ? [] : null;
  });
  const sending = threads.send(state.key, [
    { type: "text", text: "Dispatched" },
  ]);
  await dispatched.promise;
  await threads.cancel(state.key);
  const prompt = invoke.mock.calls.find(
    ([command]) => command === "session_prompt",
  )![1] as PromptArgs;
  expect(invoke).toHaveBeenCalledWith("session_prompt_cancel", {
    agentId: "a",
    cwd: "/p",
    sessionId: id,
    connectionId: state.connectionId,
    promptToken: prompt.promptToken,
    receiptId: receipt(prompt),
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
  ).applyChannelEvent(state.key, {
    kind: "turnEnd",
    promptReceiptId: receipt(prompt),
    stopReason: "cancelled",
  });
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
    ready(state);
    const dispatched = deferred();
    const rejectAdmission = deferred();
    invoke.mockImplementation(async (command: string, args) => {
      if (command === "session_prompt") {
        offer(args, "preparing");
        dispatched.resolve();
        await rejectAdmission.promise;
        return { status: "rejected", reason: "work_disabled" };
      }
      if (command === "session_prompt_cancel") {
        if (cancelFails) throw new Error("Cancellation reply unavailable");
        return { receiptId: args.receiptId, outcome: "cancelledBeforeOffer" };
      }
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
    ready(state);
    const dispatched = deferred();
    const settleAdmission = deferred();
    invoke.mockImplementation(async (command: string, args) => {
      if (command === "session_prompt") {
        offer(args);
        dispatched.resolve();
        await settleAdmission.promise;
        if (outcome === "lost-reply") throw new Error("IPC reply lost");
        return { status: "unknown" };
      }
      if (command === "session_prompt_cancel") return cancelReply(args);
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

it.each(["known-receipt", "late-receipt"] as const)(
  "keeps an unsent request after %s waiting cancellation fails without an unhandled auto-cancel rejection",
  async (timing) => {
    const id = `waiting-cancel-fails-${timing}`;
    const state = threads.markOpenFailed(
      `a:/p:${id}`,
      "a",
      "/p",
      id,
      "fixture",
    );
    ready(state);
    const dispatched = deferred();
    const settle = deferred();
    let prompt!: PromptArgs;
    invoke.mockImplementation(async (command: string, args) => {
      if (command === "session_prompt") {
        prompt = args;
        if (timing === "known-receipt") offer(args, "waiting");
        dispatched.resolve();
        await settle.promise;
        return { status: "rejected", reason: "send_wait_limit" };
      }
      if (command === "session_prompt_cancel")
        throw new Error("controlled cancellation reply unavailable");
      return command === "session_index_list" ? [] : null;
    });
    const blocks: PromptBlock[] = [
      { type: "text", text: "Keep the owned input" },
    ];
    const sending = threads.send(state.key, blocks);
    await dispatched.promise;
    await threads.cancel(state.key);
    if (timing === "late-receipt") {
      expect(
        invoke.mock.calls.filter(
          ([command]) => command === "session_prompt_cancel",
        ),
      ).toHaveLength(0);
      offer(prompt, "waiting");
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith("session_prompt_cancel", {
      agentId: "a",
      cwd: "/p",
      sessionId: id,
      connectionId: state.connectionId,
      promptToken: prompt.promptToken,
      receiptId: receipt(prompt),
    });
    expect(
      invoke.mock.calls.filter(([command]) => command === "session_cancel"),
    ).toHaveLength(0);
    expect(state).toMatchObject({
      running: false,
      submitting: true,
      stopping: false,
      stopUnconfirmed: false,
      uncertainPrompt: null,
      queued: [blocks],
      queuePaused: "stopped",
    });
    expect(state.promptAdmission?.notice).toBe(S.unconfirmed);
    expect(state.items.some((item) => item.kind === "settled")).toBe(false);
    // A later explicit rejection proves it remained unsent, independently of
    // the failed cancel acknowledgement. No retry or completion is fabricated.
    settle.resolve();
    expect(await sending).toEqual({
      status: "rejected",
      reason: "send_wait_limit",
    });
    expect(state.queued).toEqual([blocks]);
    expect(
      invoke.mock.calls.filter(([command]) => command === "session_prompt"),
    ).toHaveLength(1);
  },
);
