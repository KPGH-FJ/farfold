import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { emitOpeningHeader } from "./session_open_test_fixture";

beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open") {
      const result = {
        cwd: args.cwd,
        nativeSessionId: args.nativeSessionId,
        connectionId: `lifecycle-connection-${args.nativeSessionId}`,
        resumed: true,
        configOptions: [],
      };
      emitOpeningHeader(args, result);
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retained history" },
        },
      });
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return result;
    }
    return command === "settings_get" ? 0 : [];
  });
});

function lose(key: string, closeReason: unknown) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(key, { kind: "connectionLost", closeReason });
}

it("delivery interruption pauses new input while preserving running and unknown-work evidence", () => {
  const state = threads.markOpenFailed(
    "a:/idle:delivery-gap",
    "a",
    "/idle",
    "delivery-gap",
    "fixture",
  );
  state.openError = null;
  state.running = true;
  state.connectionOutcomeUnknown = true;
  state.queued = [[{ type: "text", text: "Keep this pending" }]];
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(state.key, { kind: "deliveryUnavailable" });
  expect(state.sourceError).toBe(true);
  expect(state.running).toBe(true);
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(state.connectionLost).toBe(false);
  expect(state.queuePaused).toBeTruthy();
  expect(state.queued).toEqual([[{ type: "text", text: "Keep this pending" }]]);
  expect(
    h.invoke.mock.calls.some(([command]) =>
      /prompt|cancel|disconnect/.test(command),
    ),
  ).toBe(false);
});

it("records why a connection ended without turning idle closure into unknown work", () => {
  const state = threads.markOpenFailed(
    "a:/idle:lifecycle-idle",
    "a",
    "/idle",
    "lifecycle-idle",
    "fixture",
  );
  state.openError = null;
  lose(state.key, "idle");
  expect(state.connectionCloseReason).toBe("idle");
  expect(state.connectionOutcomeUnknown).toBe(false);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("treats unrecognized closure reasons conservatively", () => {
  const state = threads.markOpenFailed(
    "a:/idle:lifecycle-other",
    "a",
    "/idle",
    "lifecycle-other",
    "fixture",
  );
  lose(state.key, "untrusted-reason");
  expect(state.connectionCloseReason).toBe("unexpected");
});

it("keeps unknown execution and paused input across a successful history restore", async () => {
  const state = threads.markOpenFailed(
    "a:/idle:lifecycle-unknown",
    "a",
    "/idle",
    "lifecycle-unknown",
    "fixture",
  );
  state.openError = null;
  state.running = true;
  state.queued = [[{ type: "text", text: "Do not resend" }]];
  lose(state.key, "unexpected");
  expect(state.connectionOutcomeUnknown).toBe(true);
  const restored = await threads.reconnect(state.key);
  expect(restored?.connectionLost).toBe(false);
  expect(restored?.connectionOutcomeUnknown).toBe(true);
  expect(restored?.queued).toEqual(state.queued);
  expect(restored?.queuePaused).toBeTruthy();
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_open"),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});
