import { describe, expect, it, vi } from "vitest";
import {
  AgentPreparation,
  preparationFor,
  preparationMatches,
  preparationNeedsExplicitRead,
  type PreparationInput,
} from "./agent_preparation";
import { invalidateAuthentication } from "./authentication";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
  type SendAdmission,
  type ThreadState,
} from "./sessions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const states = new Map<string, ThreadState>();
  const listeners = new Map<string, Set<() => void>>();
  let sequence = 0;
  const admission = deferred<SendAdmission>();
  const emit = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const port = {
    open: vi.fn(async () => {
      const s = freshThreadState(
        `agent:/work:${++sequence}`,
        "agent",
        "/work",
        String(sequence),
      );
      states.set(s.key, s);
      return s;
    }),
    thread: (key: string) => states.get(key),
    subscribeThread: (key: string, callback: () => void) => {
      const set = listeners.get(key) ?? new Set<() => void>();
      set.add(callback);
      listeners.set(key, set);
      return () => {
        set.delete(callback);
      };
    },
    send: vi.fn(async (key: string, blocks: ThreadState["queued"][number]) => {
      const s = states.get(key)!;
      s.running = s.submitting = true;
      s.queued.push(blocks);
      emit(key);
      const result = await admission.promise;
      if (result.status === "accepted") {
        s.identity = "established";
        s.queued = [];
      }
      if (result.status === "unknown") {
        s.identity = "established";
        s.uncertainPrompt = blocks;
      }
      if (result.status !== "accepted") s.running = false;
      s.submitting = false;
      emit(key);
      return result;
    }),
    cancel: vi.fn(async (key: string) => {
      states.get(key)!.stopping = true;
      emit(key);
    }),
    discardDraft: vi.fn(async (key: string) => {
      states.delete(key);
    }),
    dequeue: vi.fn((key: string, index: number) => {
      states.get(key)!.queued.splice(index, 1);
    }),
    rename: vi.fn(async () => {}),
  };
  const controller = new AgentPreparation(port, () => "challenge");
  const input: PreparationInput = {
    agentId: "agent",
    agentName: "Example",
    cwd: "/work",
    program: "program1",
    service: null,
  };
  const state = () => states.get(controller.getSnapshot().threadKey!)!;
  const text = (value = "FARFOLD-challenge") => {
    applyUpdate(state(), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: value },
    });
    emit(state().key);
  };
  const end = (stopReason = "end_turn", failure?: unknown) => {
    applyTurnEnd(state(), { stopReason, failure });
    emit(state().key);
  };
  return { controller, port, input, states, state, admission, emit, text, end };
}

describe("preparation result context", () => {
  it.each([
    { label: "open error", change: { openError: "read failed" } },
    { label: "model drift", change: { modelDrift: true } },
    { label: "config error", change: { configError: "choice failed" } },
    { label: "connection lost", change: { connectionLost: true } },
    { label: "source error", change: { sourceError: true } },
    { label: "configuring", change: { configuring: true } },
  ])(
    "keeps the explicit gate when an empty-choice read returns $label",
    async ({ change }) => {
      const f = fixture();
      const thread = freshThreadState("failed-read", "agent", "/work", "read");
      Object.assign(thread, change);
      f.states.set(thread.key, thread);
      f.port.open.mockResolvedValueOnce(thread);
      f.controller.requireExplicitRead(f.input);
      await f.controller.prepare(f.input, true);
      expect(
        preparationNeedsExplicitRead(f.controller.getSnapshot(), f.input),
      ).toBe(true);
      expect(f.controller.getSnapshot().phase).toBe("failed");
      expect(f.controller.getSnapshot().error).toBeTruthy();
      expect(f.controller.getSnapshot().readError).toBeTruthy();
      expect(f.port.send).not.toHaveBeenCalled();
    },
  );
  it.each(["rejected", "selection-mismatch", "invalidated", "confirmed"])(
    "keeps the explicit gate until a current read actually confirms the choice (%s)",
    async (outcome) => {
      const f = fixture(),
        waiting = deferred<ThreadState>();
      const input = { ...f.input, config: { model: "chosen", mode: "off" } };
      f.controller.requireExplicitRead(input);
      f.port.open.mockReturnValueOnce(waiting.promise);
      const reading = f.controller.prepare(input, true);
      expect(
        preparationNeedsExplicitRead(f.controller.getSnapshot(), input),
      ).toBe(true);
      if (outcome === "invalidated") f.controller.invalidate();
      const thread = freshThreadState("read-result", "agent", "/work", "read");
      thread.configOptions = Object.entries(input.config).map(
        ([id, value]) => ({
          id,
          name: id,
          type: "select",
          currentValue:
            outcome === "selection-mismatch" && id === "mode" ? "on" : value,
          options: [],
        }),
      );
      f.states.set(thread.key, thread);
      if (outcome === "rejected") {
        // Reject through a real failed open while the original pending read is invalidated.
        f.controller.invalidate();
        waiting.resolve(thread);
        await reading;
        f.port.open.mockRejectedValueOnce(new Error("read failed"));
        await f.controller.prepare(input, true);
      } else {
        waiting.resolve(thread);
        await reading;
      }
      expect(
        preparationNeedsExplicitRead(f.controller.getSnapshot(), input),
      ).toBe(outcome !== "confirmed");
      expect(f.port.send).not.toHaveBeenCalled();
    },
  );
  it("retains an original target's explicit model-read gate through reconnect and other targets", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    f.controller.requireExplicitRead({
      agentId: f.input.agentId,
      cwd: f.input.cwd,
    });
    f.controller.invalidate();
    await f.controller.prepare(f.input);
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(
      preparationNeedsExplicitRead(f.controller.getSnapshot(), f.input),
    ).toBe(true);
    await f.controller.prepare({ ...f.input, cwd: "/other" }, true);
    expect(f.port.open).toHaveBeenCalledTimes(2);
    await f.controller.prepare(f.input);
    expect(f.port.open).toHaveBeenCalledTimes(2);
    expect(
      preparationNeedsExplicitRead(f.controller.getSnapshot(), f.input),
    ).toBe(true);
    await f.controller.prepare(f.input, true);
    expect(f.port.open).toHaveBeenCalledTimes(3);
    expect(
      preparationNeedsExplicitRead(f.controller.getSnapshot(), f.input),
    ).toBe(false);
    expect(f.port.send).not.toHaveBeenCalled();
  });
  it("retains a failed model read until one explicit retry or a changed selection", async () => {
    const f = fixture();
    f.port.open.mockRejectedValue(new Error("model-read-fixture-error"));
    await f.controller.prepare(f.input);
    const failed = f.controller.getSnapshot();
    expect(failed.phase).toBe("failed");
    for (let i = 0; i < 4; i++)
      await f.controller.prepare({ ...f.input, config: {} });
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot()).toBe(failed);
    await f.controller.prepare(f.input, true);
    expect(f.port.open).toHaveBeenCalledTimes(2);
    expect(f.controller.getSnapshot().phase).toBe("failed");
    await f.controller.prepare({ ...f.input, config: { model: "B" } });
    expect(f.port.open).toHaveBeenCalledTimes(3);
    expect(f.port.send).not.toHaveBeenCalled();
  });

  it("never treats a newly selected model as the older preparation's result", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    f.state().configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "A",
        options: [
          { value: "A", name: "A" },
          { value: "B", name: "B" },
        ],
      },
    ];
    f.emit(f.state().key);
    const oldKey = f.state().key;
    const previous = f.controller.getSnapshot();
    expect(
      preparationMatches(previous, { ...f.input, config: { model: "A" } }),
    ).toBe(true);
    const selected = { ...f.input, config: { model: "B" } };
    expect(preparationMatches(previous, selected)).toBe(false);
    await f.controller.prepare(selected);
    expect(f.port.open).toHaveBeenCalledTimes(2);
    expect(f.port.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ configOptions: { model: "B" } }),
    );
    expect(f.port.discardDraft).toHaveBeenCalledWith(oldKey);
    expect(f.port.send).not.toHaveBeenCalled();
  });

  it("adopts omitted defaults but never replaces an explicitly selected thinking value", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const snapshot = {
      ...f.controller.getSnapshot(),
      config: { model: "A", thinking: "high" },
    };
    expect(
      preparationMatches(snapshot, { ...f.input, config: { model: "A" } }),
    ).toBe(true);
    expect(
      preparationMatches(snapshot, {
        ...f.input,
        config: { model: "A", thinking: "off" },
      }),
    ).toBe(false);
  });

  it("discards a late model read from an earlier choice without overwriting the newer request", async () => {
    const f = fixture();
    const old = deferred<ThreadState>();
    f.port.open.mockImplementationOnce(() => old.promise);
    const first = f.controller.prepare({ ...f.input, config: { model: "A" } });
    await f.controller.prepare({ ...f.input, config: { model: "B" } });
    const newer = f.controller.getSnapshot();
    old.resolve(freshThreadState("old-A", "agent", "/work", "old-A"));
    await first;
    expect(f.controller.getSnapshot()).toEqual(newer);
    expect(newer.input?.config).toEqual({ model: "B" });
    expect(f.port.discardDraft).toHaveBeenCalledWith("old-A");
  });

  it("does not use a draft or result from another folder, program or selected service", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const snapshot = f.controller.getSnapshot();
    expect(preparationMatches(snapshot, f.input)).toBe(true);
    expect(preparationMatches(snapshot, { ...f.input, cwd: "/other" })).toBe(
      false,
    );
    expect(preparationMatches(snapshot, { ...f.input, agentId: "other" })).toBe(
      false,
    );
    expect(
      preparationMatches(snapshot, { ...f.input, program: "changed" }),
    ).toBe(false);
    const service = { id: "saved", revision: "r1", model: "chosen" };
    expect(preparationMatches(snapshot, { ...f.input, service })).toBe(false);
    await f.controller.prepare({ ...f.input, service });
    expect(
      preparationMatches(f.controller.getSnapshot(), {
        ...f.input,
        service: { ...service, revision: "r2" },
      }),
    ).toBe(false);
  });
});

describe("real Agent preparation request ownership", () => {
  it("revokes only the relevant existing owner for authentication actions outside setup", () => {
    const changed = preparationFor("auth-changed");
    const other = preparationFor("auth-unrelated");
    invalidateAuthentication("auth-changed");
    expect(changed.getSnapshot().phase).toBe("stale");
    expect(other.getSnapshot().phase).toBe("untested");
  });

  it("opens only an isolated draft until clicked, deduplicates clicks, and waits for admission plus a matching completed reply", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    await f.controller.prepare(f.input);
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.port.open).toHaveBeenCalledWith(
      expect.objectContaining({
        fresh: true,
        draftScope: expect.stringContaining("preparation:"),
      }),
    );
    expect(f.port.send).not.toHaveBeenCalled();
    const sending = f.controller.start();
    await f.controller.start();
    expect(f.port.send).toHaveBeenCalledTimes(1);
    expect(f.port.send.mock.calls[0][1][0]).toMatchObject({
      text: f.controller.getSnapshot().prompt,
    });
    f.text();
    f.end();
    expect(f.controller.getSnapshot().phase).not.toBe("passed");
    f.admission.resolve({ status: "accepted" });
    await sending;
    expect(f.controller.getSnapshot().phase).toBe("passed");
    expect(f.controller.verified("program1")).toBe(true);
    expect(f.port.rename).toHaveBeenCalledWith(
      f.state().key,
      "连接测试 · Example",
    );
  });

  it.each([
    "",
    "service error",
    "FARFOLD-challenge but not the requested reply",
  ])(
    "does not promote end_turn with %j to a successful test",
    async (reply) => {
      const f = fixture();
      await f.controller.prepare(f.input);
      const sending = f.controller.start();
      f.admission.resolve({ status: "accepted" });
      await sending;
      if (reply) f.text(reply);
      f.end();
      expect(f.controller.getSnapshot()).toMatchObject({
        phase: "failed",
        reply,
      });
    },
  );

  it("requires terminal success even when the challenge appeared", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const sending = f.controller.start();
    f.admission.resolve({ status: "accepted" });
    await sending;
    f.text();
    expect(f.controller.getSnapshot().phase).toBe("running");
    f.end("end_turn", { category: "service" });
    expect(f.controller.getSnapshot().phase).toBe("failed");
    expect(f.controller.getSnapshot().readError).toBeNull();
  });

  it("cancel during admission cannot precede the prompt, and late success never authorizes setup", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const sending = f.controller.start();
    f.controller.stop();
    expect(f.port.cancel).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().phase).toBe("stopping");
    f.admission.resolve({ status: "accepted" });
    await sending;
    expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(f.state().key);
    f.text();
    f.end();
    expect(f.controller.getSnapshot().phase).toBe("cancelled");
    expect(f.controller.verified("program1")).toBe(false);
    expect(f.port.discardDraft).not.toHaveBeenCalled();
  });

  it("retains an unknown admission and blocks a duplicate test", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const sending = f.controller.start();
    f.admission.resolve({ status: "unknown" });
    await sending;
    expect(f.controller.getSnapshot().phase).toBe("unknown");
    expect(f.controller.canPrepare()).toBe(false);
    await f.controller.prepare(f.input, true);
    await f.controller.start();
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.port.send).toHaveBeenCalledTimes(1);
  });

  it("retains admission ownership when terminal events arrive before a source change", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const sending = f.controller.start();
    f.text();
    f.end();
    f.controller.invalidate();
    expect(f.controller.canPrepare()).toBe(false);
    await f.controller.prepare({ ...f.input, program: "replacement" }, true);
    expect(f.port.open).toHaveBeenCalledTimes(1);
    f.admission.resolve({ status: "accepted" });
    await sending;
    expect(f.controller.verified("program1")).toBe(false);
    expect(f.controller.canPrepare()).toBe(true);
    await f.controller.prepare({ ...f.input, program: "replacement" }, true);
    expect(f.port.open).toHaveBeenCalledTimes(2);
  });

  it("revokes a passed result after model changes or connection loss", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const sending = f.controller.start();
    f.admission.resolve({ status: "accepted" });
    await sending;
    f.text();
    f.end();
    f.state().connectionLost = true;
    f.emit(f.state().key);
    expect(f.controller.getSnapshot().phase).toBe("unknown");
    expect(f.controller.verified("program1")).toBe(false);
    f.state().connectionLost = false;
    f.state().modelDrift = true;
    f.emit(f.state().key);
    expect(f.controller.getSnapshot().phase).toBe("stale");
    expect(f.controller.verified("program1")).toBe(false);
  });

  it("keeps pending approvals visible through the actual thread and permits completion after handoff", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const sending = f.controller.start();
    f.admission.resolve({ status: "accepted" });
    await sending;
    f.state().pendingElicitations.push({
      requestId: "question",
      toolCallId: null,
      message: "answer",
      schema: null,
      values: {},
      status: "pending",
      error: null,
    });
    f.emit(f.state().key);
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: "needs_action",
      threadKey: f.state().key,
    });
    f.state().pendingElicitations = [];
    f.text();
    f.end();
    expect(f.controller.getSnapshot().phase).toBe("passed");
  });

  it("discards a late unprompted open after the preparation was closed", async () => {
    const f = fixture();
    const opening = deferred<ThreadState>();
    f.port.open.mockImplementationOnce(() => opening.promise);
    const pending = f.controller.prepare(f.input);
    f.controller.invalidate();
    const late = freshThreadState("late", "agent", "/work", "late");
    opening.resolve(late);
    await pending;
    expect(f.port.discardDraft).toHaveBeenCalledWith("late");
    expect(f.controller.getSnapshot().threadKey).toBeNull();
    expect(f.port.send).not.toHaveBeenCalled();
  });

  it("loses verification on context changes and prepares a new conversation without deleting the tested one", async () => {
    const f = fixture();
    await f.controller.prepare(f.input);
    const oldKey = f.state().key;
    const sending = f.controller.start();
    f.admission.resolve({ status: "accepted" });
    await sending;
    f.text();
    f.end();
    f.controller.invalidate();
    expect(f.controller.verified("program1")).toBe(false);
    await f.controller.prepare({
      ...f.input,
      service: { id: "api", model: "m", revision: "v2" },
    });
    expect(f.state().key).not.toBe(oldKey);
    expect(f.states.has(oldKey)).toBe(true);
    expect(f.controller.getSnapshot().phase).toBe("untested");
    expect(f.port.send).toHaveBeenCalledTimes(1);
  });
});
