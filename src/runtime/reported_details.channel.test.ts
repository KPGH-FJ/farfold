import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("preserves transport envelope and guarded configuration extras without inventing a message", () => {
  vi.useFakeTimers();
  const state = threads.markOpenFailed(
    "details:channel",
    "fixture",
    "/work",
    "native",
    "fixture",
  );
  state.openError = null;
  const send = (value: unknown) =>
    (
      threads as unknown as {
        applyChannelEvent(key: string, value: unknown): void;
      }
    ).applyChannelEvent(state.key, value);
  send({
    sessionId: "native",
    _meta: { envelope: true },
    unknownEnvelope: null,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "m",
      content: { type: "text", text: "A" },
      _meta: { update: true },
    },
  });
  send({
    sessionId: "native",
    _meta: { extra: true },
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "choice", name: "Choice", type: "boolean", currentValue: true },
      ],
    },
  });
  send({
    sessionId: "native",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "m",
      content: { type: "text", text: "B" },
    },
  });
  expect(state.items).toHaveLength(1);
  expect(state.items[0]).toMatchObject({
    text: "AB",
    reportedDetails: {
      "/_meta": { envelope: true },
      "/unknownEnvelope": null,
      "/update/_meta": { update: true },
    },
  });
  expect(state.reportedDetails).toEqual({
    "/config_option_update/_meta": { extra: true },
  });
  expect(state.configOptions).toEqual([]);
});
