import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), opens: [] as any[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { emitOpeningHeader } from "./session_open_test_fixture";

const queueId = "ab".repeat(16);
beforeEach(() => {
  h.invoke.mockReset();
  h.opens.length = 0;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      h.opens.push(args);
      const result = {
        cwd: args.cwd,
        nativeSessionId: args.nativeSessionId ?? "preparation-draft",
        connectionId: `connection-${h.opens.length}`,
        resumed: Boolean(args.nativeSessionId),
        service: null,
        configOptions: [],
        configCheck: {
          status: "ready",
          issues: [],
          protectedIds: [],
          current: { choices: [] },
        },
        permissionState: "ready",
      };
      emitOpeningHeader(args, result);
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Owned history" },
        },
      });
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      args.channel.onmessage({
        farfoldDeliveryWake: { openToken: args.openToken, queueId },
      });
      return result;
    }
    if (command === "session_delivery_pull") return null;
    if (command === "agent_work_get") return { cwd: args.cwd };
    return command === "settings_get" ? 0 : [];
  });
});
async function open(id: string) {
  return threads.open({
    agentId: "retirement",
    cwd: "/project",
    nativeSessionId: id,
  });
}
function retired(open: any) {
  return h.invoke.mock.calls.filter(
    ([command, args]) =>
      command === "session_delivery_retire" &&
      args.openToken === open.openToken,
  );
}
it("connectionLost releases original delivery while the independent process receipt remains usable", async () => {
  const state = await open("lost-delivery");
  const wire = h.opens[0];
  wire.channel.onmessage({ kind: "connectionLost", closeReason: "unexpected" });
  expect(retired(wire)).toHaveLength(1);
  expect(state.connectionLost).toBe(true);
  expect(state.processEndedConnectionId).toBeUndefined();
  wire.channel.onmessage({ kind: "configOptions", options: [{ id: "late" }] });
  expect(state.configOptions).toEqual([]);
  wire.processEndedChannel.onmessage({
    connectionId: state.connectionId,
    closeReason: "unexpected",
  });
  expect(state.processEndedConnectionId).toBe(state.connectionId);
  expect(retired(wire)).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(([command]) => /cancel|disconnect/.test(command)),
  ).toBe(false);
});
it("normal close retires local delivery before its existing close command", async () => {
  const state = await open("normal-close");
  const wire = h.opens[0];
  await threads.close(state.key);
  expect(retired(wire)).toHaveLength(1);
  const commands = h.invoke.mock.calls.map(([command]) => command);
  expect(commands.indexOf("session_delivery_retire")).toBeLessThan(
    commands.indexOf("session_close"),
  );
  wire.channel.onmessage({ kind: "notification", message: "late" });
  expect(threads.thread(state.key)).toBeUndefined();
});
it("confirmed preparation close retires its delivery while retaining startup content", async () => {
  const state = await threads.open({
    agentId: "retirement",
    cwd: "/preparation-local",
    fresh: true,
  });
  const wire = h.opens[0];
  const content = state.items;
  expect(state.identity).toBe("draft");
  await threads.retirePreparationDraft(state.key, () => true);
  expect(retired(wire)).toHaveLength(1);
  expect(threads.thread(state.key)).toBe(state);
  expect(state.items).toBe(content);
  expect(state.items).toContainEqual(
    expect.objectContaining({ text: "Owned history" }),
  );
  expect(state.processEndedConnectionId).toBeUndefined();
});
it("configuration recheck replaces the exact channel and leaves its new owner active", async () => {
  const state = await open("recheck-channel");
  const first = h.opens[0];
  first.channel.onmessage({
    kind: "configCheck",
    check: {
      status: "blocked",
      issues: [{ id: "model", reason: "unknown" }],
      current: { choices: [] },
    },
  });
  await threads.recheckConfig(state.key);
  const second = h.opens[1];
  expect(second).toBeDefined();
  expect(retired(first)).toHaveLength(1);
  expect(retired(second)).toHaveLength(0);
  first.channel.onmessage({
    kind: "connectionLost",
    closeReason: "unexpected",
  });
  expect(threads.thread(state.key)?.connectionLost).toBe(false);
  second.channel.onmessage({
    kind: "connectionLost",
    closeReason: "unexpected",
  });
  expect(threads.thread(state.key)?.connectionLost).toBe(true);
  expect(retired(second)).toHaveLength(1);
});
