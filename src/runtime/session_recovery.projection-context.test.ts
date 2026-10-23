// True production entry points, only Tauri transport is mocked.
import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult } from "./sessions";
import { historyFailureKey, isHistoryReadFailure } from "./session_recovery";
import { SessionOpenReplay } from "./session_open_replay";
const access = threads as unknown as {
  applyChannelEvent(key: string, event: unknown, live?: boolean): void;
};
const result: OpenResult = {
  cwd: "/architecture",
  nativeSessionId: "same",
  connectionId: "architecture-connection",
  resumed: true,
  configOptions: [],
  warnings: [],
};
const readable = {
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "READABLE" },
  },
};
function replay(event: unknown, reply: OpenResult) {
  const reader = new SessionOpenReplay({
    agentId: "architecture",
    cwd: reply.cwd,
  });
  reader.push({
    kind: "sessionOpening",
    openToken: reader.token,
    cwd: reply.cwd,
    sessionId: reply.nativeSessionId,
    connectionId: reply.connectionId,
  });
  expect(reader.push(readable)).toBe("consumed");
  expect(reader.push(event)).toBe("consumed");
  reader.receiveMarker({
    kind: "session_history_complete",
    openToken: reader.token,
  });
  return reader;
}
function expectTypedFailure(reader: SessionOpenReplay, reply: OpenResult) {
  let failure: unknown;
  try {
    reader.accept(reply, null);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(TypeError);
  expect(isHistoryReadFailure(failure)).toBe(true);
  expect(historyFailureKey(failure)).toBe(
    `architecture:${reply.cwd}:${reply.nativeSessionId}`,
  );
  reader.clear();
}
it("rejects malformed historical config with a typed failure while the live channel retains the same update raw", async () => {
  const state = threads.markOpenFailed(
    "architecture:/architecture:config",
    "architecture",
    "/architecture",
    "config",
    "fixture",
  );
  state.openError = null;
  const bad = JSON.parse('{"toString":null,"valueOf":null}');
  const event = {
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: bad, name: "owned", type: "boolean", currentValue: false },
      ],
    },
  };
  const reply = { ...result, nativeSessionId: state.nativeSessionId };
  expectTypedFailure(replay(event, reply), reply);
  expect(() => access.applyChannelEvent(state.key, event, false)).not.toThrow();
  expect(
    state.items.some(
      (item) => item.kind === "raw" && item.update === event.update,
    ),
  ).toBe(true);
  await threads.close(state.key);
});
it("validates malformed historical mode against the actual returned legacy baseline", async () => {
  const state = threads.markOpenFailed(
    "architecture:/architecture:mode",
    "architecture",
    "/architecture",
    "mode",
    "fixture",
  );
  state.openError = null;
  state.modesSeparate = true;
  const event = {
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: JSON.parse('{"toString":null,"valueOf":null}'),
    },
  };
  const reply = { ...result, nativeSessionId: state.nativeSessionId };
  const withoutLegacy = replay(event, reply).accept(reply, null);
  expect(withoutLegacy.items).toContainEqual(
    expect.objectContaining({ kind: "agent", text: "READABLE" }),
  );
  const legacyReply = {
    ...reply,
    configOptionsModern: false,
    modes: {
      currentModeId: "ask",
      availableModes: [{ id: "ask", name: "Ask" }],
    },
  };
  expectTypedFailure(replay(event, legacyReply), legacyReply);
  expect(() => access.applyChannelEvent(state.key, event, false)).toThrow(
    TypeError,
  );
  await threads.close(state.key);
});
