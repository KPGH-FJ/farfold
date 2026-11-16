// Actual locked Tauri Channel sequencing + actual ThreadsStore open/send path.
// Only native IPC/draft persistence is controlled. No WebView, Agent or RSS claim.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Channel } from "@tauri-apps/api/core";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: h.invoke };
});
import { threads } from "./sessions";
import { draftPersistence } from "./drafts";
import { archiveActivity } from "./archive_activity";
import { historyFailureKey, isHistoryReadFailure } from "./session_recovery";
import { SessionOpenReplay } from "./session_open_replay";
import { emitOpeningHeader } from "./session_open_test_fixture";

type Wire = {
  channel: Channel<unknown>;
  admissionChannel: Channel<unknown>;
};
const callbacks = new Map<number, (value: unknown) => void>();
const positions = new WeakMap<Channel<unknown>, number>();
const keys: string[] = [];
let callbackId = 0;
let serial = 0;
let wire: Wire;
const callbackErrors: unknown[] = [];
function deliver(channel: Channel<unknown>, message: unknown): void {
  const index = positions.get(channel) ?? 0;
  positions.set(channel, index + 1);
  const callback = callbacks.get(channel.id);
  expect(callback).toBeTypeOf("function");
  // Like separate native deliveries, later indices are still submitted if one
  // callback throws. The real Channel, not this harness, owns their ordering.
  try {
    callback!({ index, message });
  } catch (error) {
    callbackErrors.push(error);
  }
}
beforeEach(() => {
  callbacks.clear();
  callbackErrors.length = 0;
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      transformCallback(callback: (value: unknown) => void) {
        const id = ++callbackId;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
    },
  });
  vi.stubGlobal("document", { hidden: false, hasFocus: () => true });
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open") {
      wire = args;
      const result = {
        cwd: "/owned-channel",
        nativeSessionId: `live-${++serial}`,
        connectionId: `live-connection-${serial}`,
        resumed: false,
        configOptions: [],
        warnings: [],
        permissionState: "ready",
        configCheck: { status: "ready", issues: [], current: { choices: [] } },
      };
      emitOpeningHeader(
        {
          openToken: args.openToken,
          channel: { onmessage: (event) => deliver(args.channel, event) },
        },
        result,
      );
      return result;
    }
    if (command === "session_prompt") {
      deliver(args.admissionChannel, { receiptId: 1, phase: "offered" });
      return { status: "accepted" };
    }
    if (command === "session_prompt_cancel")
      return { receiptId: args.receiptId, outcome: "cancelRequested" };
    if (command === "settings_get") return 0;
    return command === "session_index_list" ? [] : null;
  });
});
afterEach(async () => {
  // No native process exists in this test. Close the exact local stores/timers
  // even on RED; clearing this controlled callback registry is not App cleanup.
  for (const key of keys.splice(0)) await threads.close(key);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  callbacks.clear();
  h.invoke.mockReset();
});

it.each(["toolCallId", "title"] as const)(
  "keeps ordered opaque input, approvals and actual cancellation after an invalid live %s",
  async (field) => {
    const state = await threads.open({
      agentId: `channel-${field}`,
      cwd: "/owned-channel",
    });
    keys.push(state.key);
    expect(
      await threads.send(state.key, [{ type: "text", text: "Owned input" }]),
    ).toEqual({ status: "accepted" });
    const channel = wire.channel;
    deliver(channel, { kind: "toolActivity", toolCallIds: ["known-tool"] });
    deliver(channel, {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "known-tool",
        title: "Keep title",
        kind: "read",
        status: "in_progress",
      },
    });
    const oldTool = state.items.find((item) => item.kind === "tool");
    const bad = {
      sessionId: state.nativeSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "known-tool",
        [field]: JSON.parse('{"toString":null,"valueOf":null}'),
      },
      opaqueEnvelope: { array: [null, false, "原值🙂"] },
    };
    deliver(channel, bad);
    // Same bounded workload as the prior 64x16KiB production transport sample.
    // Its exact values stay retained; this is not an RSS or capacity assertion.
    const opaque = Array.from({ length: 64 }, (_, sequence) => ({
      update: {
        sessionUpdate: "_owned/full-opaque",
        sequence,
        text: "x".repeat(16 * 1024),
      },
      futureEnvelope: { sequence, nil: null },
    }));
    for (const value of opaque) deliver(channel, value);
    deliver(channel, {
      kind: "permissionRequest",
      requestId: "owned-approval",
      toolCall: {
        toolCallId: "approval-tool",
        title: "Owned approval",
        kind: "read",
      },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    });

    // Complete all necessary local cancellation/retirement actions before any
    // expected RED assertion. Only the real Channel decides which indices run.
    const afterBurst = {
      active: [...state.activeToolCallIds],
      running: state.running,
      unknown: state.connectionOutcomeUnknown,
      approvals: state.pendingPermissions.map((request) => request.requestId),
    };
    await threads.cancel(state.key);
    const afterCancel = {
      running: state.running,
      active: [...state.activeToolCallIds],
    };
    deliver(channel, { kind: "interactionsCancelled" });
    deliver(channel, { kind: "toolActivity", toolCallIds: [] });
    deliver(channel, {
      kind: "turnEnd",
      promptReceiptId: 1,
      stopReason: "cancelled",
    });
    expect(callbackErrors).toEqual([]);
    expect(
      state.items.some((item) => item.kind === "raw" && item.update === bad),
    ).toBe(true);
    const raw = state.items.filter(
      (item) =>
        item.kind === "raw" &&
        opaque.some((value) => item.update === value.update),
    );
    expect(raw).toHaveLength(64);
    for (const [index, item] of raw.entries()) {
      expect(item.kind === "raw" && item.update).toBe(opaque[index].update);
      expect(item.reportedDetails?.["/futureEnvelope"]).toBe(
        opaque[index].futureEnvelope,
      );
    }
    expect(state.items).toContain(oldTool);
    expect(oldTool?.kind === "tool" && oldTool.call.title).toBe("Keep title");
    expect(
      state.items.some(
        (item) => item.kind === "user" && item.text === "Owned input",
      ),
    ).toBe(true);
    expect(afterBurst).toEqual({
      active: ["known-tool"],
      running: true,
      unknown: false,
      approvals: ["owned-approval"],
    });
    expect(state.connectionLost).toBe(false);
    expect(
      h.invoke.mock.calls.filter(
        ([command]) => command === "session_prompt_cancel",
      ),
    ).toHaveLength(1);
    expect(afterCancel).toEqual({ running: true, active: ["known-tool"] }); // ACK is never completion
    expect(state.running).toBe(false);
    expect(state.pendingPermissions).toEqual([]);
    expect(state.items.at(-1)).toMatchObject({
      kind: "settled",
      status: "stopped",
    });
    expect(
      h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
    ).toHaveLength(1);
  },
);

it("keeps the TypeError history boundary without re-projecting the delivered body", () => {
  const result = {
    cwd: "/owned-channel",
    nativeSessionId: "history",
    connectionId: "history-connection",
    resumed: true,
    configOptions: [],
    warnings: [],
  };
  const reader = new SessionOpenReplay({ agentId: "owned", cwd: result.cwd });
  reader.push({
    kind: "sessionOpening",
    openToken: reader.token,
    cwd: result.cwd,
    sessionId: result.nativeSessionId,
    connectionId: result.connectionId,
  });
  reader.push({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "READABLE_BEFORE_ERROR" },
    },
  });
  const bad = {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "malformed-tool-title",
      title: JSON.parse('{"toString":null,"valueOf":null}'),
    },
  };
  expect(reader.push(bad)).toBe("consumed");
  reader.receiveMarker({
    kind: "session_history_complete",
    openToken: reader.token,
  });
  let failure: unknown;
  try {
    reader.accept(result, null);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(TypeError);
  expect(isHistoryReadFailure(failure)).toBe(true);
  expect(historyFailureKey(failure)).toBe("owned:/owned-channel:history");
  reader.clear();
});
