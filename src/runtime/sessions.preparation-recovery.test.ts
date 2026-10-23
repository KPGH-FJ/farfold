import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));

import { threads } from "./sessions";
import { AgentPreparation } from "./agent_preparation";
import { authenticationRequired, useAuthentication } from "./authentication";
import { recheckAuthentication } from "./auth_actions";
import { draftPersistence } from "./drafts";

beforeEach(() => h.invoke.mockReset());
afterEach(async () => {
  await draftPersistence.flush();
  vi.restoreAllMocks();
});

type Outcome =
  "failed" | "passed" | "running" | "stop-unconfirmed" | "uncertain";
function scenario(outcome: Outcome) {
  let sequence = 0;
  let channel!: { onmessage: (event: unknown) => void };
  let processEndedChannel!: { onmessage: (event: unknown) => void };
  let connectionId = "";
  let ended = false;
  const endProcess = () => {
    if (ended) return;
    ended = true;
    channel.onmessage({ kind: "connectionLost", closeReason: "configuration" });
    processEndedChannel.onmessage({
      connectionId,
      closeReason: "configuration",
    });
  };
  const input = {
    agentId: `recheck-preparation-${outcome}`,
    agentName: "Example",
    cwd: "/recheck-preparation",
    program: "same-program",
    service: null,
  };
  const controller = new AgentPreparation(threads, () => outcome);
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "settings_get")
      return args?.key === "autoArchiveDays" ? 30 : null;
    if (command === "session_open") {
      channel = args.channel;
      processEndedChannel = args.processEndedChannel;
      connectionId = `connection-${outcome}-${sequence + 1}`;
      ended = false;
      const result = {
        cwd: args.cwd,
        nativeSessionId: `${outcome}-${++sequence}`,
        connectionId,
        configCheck: { status: "ready", issues: [], current: { choices: [] } },
        resumed: false,
        configOptions: [],
      };
      channel.onmessage({
        kind: "sessionOpening",
        openToken: args.openToken,
        cwd: result.cwd,
        sessionId: result.nativeSessionId,
        connectionId: result.connectionId,
      });
      return result;
    }
    if (command === "session_prompt") {
      const promptReceiptId = sequence;
      args.admissionChannel.onmessage({
        receiptId: promptReceiptId,
        phase: "offered",
      });
      if (outcome === "failed")
        channel.onmessage({
          kind: "turnEnd",
          promptReceiptId,
          error: "AUTH_REQUIRED",
        });
      if (outcome === "passed") {
        channel.onmessage({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "FARFOLD-passed" },
          },
        });
        channel.onmessage({
          kind: "turnEnd",
          promptReceiptId,
          stopReason: "end_turn",
        });
      }
      return { status: outcome === "uncertain" ? "unknown" : "accepted" };
    }
    if (command === "session_prompt_cancel") {
      if (outcome === "stop-unconfirmed")
        throw new Error("cancellation acknowledgement unavailable");
      return { receiptId: args.receiptId, outcome: "cancelRequested" };
    }
    if (command === "auth_recheck") {
      endProcess();
      return { state: "ready" };
    }
    return [];
  });
  return {
    controller,
    input,
    disconnect: () => channel.onmessage({ kind: "connectionLost" }),
    endProcess,
    required: () =>
      authenticationRequired(useAuthentication(), input.agentId, input.cwd),
  };
}

it.each(["failed", "passed"] as const)(
  "retires a settled %s test for explicit account recheck only after its external work ends",
  async (outcome) => {
    const f = scenario(outcome);
    await f.controller.prepare(f.input);
    const key = f.controller.getSnapshot().threadKey!;
    await f.controller.start();
    expect(f.controller.getSnapshot().phase).toBe(outcome);
    const prior = threads.thread(key)!;
    const settled = prior.items.find((item) => item.kind === "settled");
    expect(settled).toMatchObject({
      status: outcome === "failed" ? "failed" : "done",
      replyReceived: outcome === "passed",
    });
    expect(f.required()).toBe(outcome === "failed");
    const history = [...prior.items];
    if (outcome === "failed") {
      expect(prior.connectionOutcomeUnknown).toBe(true);
      expect(prior.running).toBe(false);
      await f.controller.prepare(f.input, true);
      expect(f.controller.getSnapshot().threadKey).toBe(key);
      await expect(
        f.controller.prepareForAccount({
          agentId: f.input.agentId,
          cwd: f.input.cwd,
        }),
      ).rejects.toBeTruthy();
      expect(
        h.invoke.mock.calls.filter(([cmd]) => cmd === "auth_recheck"),
      ).toHaveLength(0);
      f.endProcess();
      expect(prior.connectionOutcomeUnknown).toBe(true);
      expect(prior.items).toEqual(history);
    }

    // AgentAuthSection invalidates preparation before its exact-target check.
    f.controller.invalidate();
    const changed = vi.fn(async () => {});
    await recheckAuthentication(
      { agentId: f.input.agentId, cwd: f.input.cwd },
      changed,
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(prior.connectionLost).toBe(true);
    // An idle successful request stays known; an errored request stays unknown
    // even though actual process completion now permits a new explicit read.
    expect(prior.connectionOutcomeUnknown).toBe(outcome === "failed");
    expect(f.controller.getSnapshot().phase).toBe("stale");
    expect(f.controller.verified(f.input.program)).toBe(false);
    expect(f.controller.canPrepare()).toBe(true);
    expect(prior.items).toContain(settled);
    expect(prior.items).toEqual(history);
    expect(threads.thread(key)).toBe(prior);
    expect(f.required()).toBe(outcome === "failed");
    expect(
      h.invoke.mock.calls.filter(([cmd]) => cmd === "session_open"),
    ).toHaveLength(1);

    await f.controller.prepare(f.input, true);
    expect(f.controller.getSnapshot().phase).toBe("untested");
    expect(f.controller.getSnapshot().threadKey).not.toBe(key);
    expect(threads.thread(key)).toBe(prior);
    expect(f.required()).toBe(outcome === "failed");
    expect(
      h.invoke.mock.calls.filter(([cmd]) => cmd === "session_prompt"),
    ).toHaveLength(1);
  },
);

it.each(["running", "stop-unconfirmed", "uncertain"] as const)(
  "keeps an unresolved %s test protected after invalidation and connection loss",
  async (outcome) => {
    const f = scenario(outcome);
    await f.controller.prepare(f.input);
    const key = f.controller.getSnapshot().threadKey!;
    await f.controller.start();
    f.controller.invalidate();
    const prior = threads.thread(key)!;
    if (outcome === "stop-unconfirmed")
      await vi.waitFor(() => expect(prior.stopUnconfirmed).toBe(true));
    if (outcome === "uncertain") expect(prior.uncertainPrompt).not.toBeNull();
    f.disconnect();
    expect(prior.connectionOutcomeUnknown).toBe(true);
    expect(f.controller.getSnapshot().phase).toBe("unknown");
    expect(f.controller.canPrepare()).toBe(false);

    await f.controller.prepare(f.input, true);
    await f.controller.start();
    expect(f.controller.getSnapshot().threadKey).toBe(key);
    expect(threads.thread(key)).toBe(prior);
    expect(
      h.invoke.mock.calls.filter(([cmd]) => cmd === "session_open"),
    ).toHaveLength(1);
    expect(
      h.invoke.mock.calls.filter(([cmd]) => cmd === "session_prompt"),
    ).toHaveLength(1);
  },
);
