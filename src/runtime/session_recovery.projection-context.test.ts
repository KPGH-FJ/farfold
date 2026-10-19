// True production entry points, only Tauri transport is mocked.
import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult } from "./sessions";
import { requireReadableHistory } from "./session_recovery";
const access = threads as unknown as {
  applyChannelEvent(key: string, event: unknown, live?: boolean): void;
};
const result: OpenResult = {
  cwd: "/architecture",
  nativeSessionId: "same",
  resumed: true,
  configOptions: [],
};
const readable = {
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "READABLE" },
  },
};
it("precheck config conversion can throw while the real channel deliberately retains that update raw", async () => {
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
  expect(() =>
    requireReadableHistory(
      "architecture",
      { ...result, nativeSessionId: state.nativeSessionId },
      [readable, event],
      true,
      false,
    ),
  ).toThrow(TypeError);
  expect(() => access.applyChannelEvent(state.key, event, false)).not.toThrow();
  expect(
    state.items.some(
      (item) => item.kind === "raw" && item.update === event.update,
    ),
  ).toBe(true);
  await threads.close(state.key);
});
it("opened legacy mode context can throw on a field that the blank admission context skips", async () => {
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
  expect(() =>
    requireReadableHistory(
      "architecture",
      { ...result, nativeSessionId: state.nativeSessionId },
      [readable, event],
      true,
      false,
    ),
  ).not.toThrow();
  expect(() => access.applyChannelEvent(state.key, event, false)).toThrow(
    TypeError,
  );
  await threads.close(state.key);
});
