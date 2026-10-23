import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
import { SessionForks } from "./session_fork";
import { SessionDeliveryObserver } from "./session_delivery_observer";
import { freshThreadState } from "./session_projection";
import { draftPersistence } from "./drafts";
import { SessionChannels } from "./session_channels";
import { emitOpeningHeader } from "./session_open_test_fixture";
import type { ThreadState } from "./session_types";
import { applySessionEvent } from "./session_event_projection";

afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});
function fixture() {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  const parent = freshThreadState("a:/owned:parent", "a", "/owned", "parent");
  Object.assign(parent, {
    identity: "established",
    connectionId: "parent-owner",
    sessionOperations: { forkCurrentContext: true },
    configCheck: { status: "ready", issues: [], current: {} },
  });
  const views = new Map<string, ThreadState>([[parent.key, parent]]);
  const channels = new SessionChannels();
  const forks = new SessionForks({
    thread: (key) => views.get(key),
    rows: () => [],
    install: (state, channel) => {
      views.set(state.key, state);
      channels.set(state.key, channel);
    },
    ownsChannel: (key, channel) => channels.get(key) === channel,
    apply: (key, event) => applySessionEvent(views.get(key)!, event, true),
    emit: () => {},
    refreshIndex: async () => {},
  });
  return { parent, forks, views, channels };
}
const result = (wire: Record<string, any>) => ({
  status: "rejected",
  operationId: wire.operationId,
  parentConnectionId: wire.connectionId,
  parentSessionId: wire.parentSessionId,
  cwd: wire.cwd,
  childSessionId: null,
  sourceReleased: true,
  indexed: false,
  session: null,
});

it("retains terminal late metadata until explicit next-copy confirmation retires the original local owner", async () => {
  const { parent, forks } = fixture();
  const dispose = vi.spyOn(SessionDeliveryObserver.prototype, "dispose");
  let wire!: Record<string, any>;
  h.invoke.mockImplementation(async (name, args) => {
    if (name !== "session_fork_current") return [];
    wire = args;
    return result(wire);
  });
  await forks.start(parent.key);
  expect(dispose).not.toHaveBeenCalled();
  wire.channel.onmessage({
    kind: "forkResult",
    operationId: wire.operationId,
    settled: true,
    result: { ...result(wire), indexed: true },
  });
  await vi.waitFor(() => expect(parent.forkOperation?.indexed).toBe(true));
  const old = parent.forkOperation!;
  expect(forks.prepareNew(parent.key, old.operationId)).toBe(true);
  expect(dispose).toHaveBeenCalledTimes(1);
  wire.channel.onmessage({
    kind: "forkResult",
    operationId: wire.operationId,
    settled: true,
    result: { ...result(wire), childSessionId: "late" },
  });
  await Promise.resolve();
  expect(old.childSessionId).toBeUndefined();
  expect(parent.forkOperation).toBeUndefined();
  expect(
    h.invoke.mock.calls.some(([name]) =>
      ["session_cancel", "session_close"].includes(name),
    ),
  ).toBe(false);
});

it("removing an unbound source view retires delivery exactly once without asserting Agent termination", async () => {
  const { parent, forks, views } = fixture();
  const dispose = vi.spyOn(SessionDeliveryObserver.prototype, "dispose");
  let wire!: Record<string, any>;
  h.invoke.mockImplementation(async (name, args) => {
    if (name !== "session_fork_current") return [];
    wire = args;
    return { ...result(wire), status: "unknown", sourceReleased: false };
  });
  await forks.start(parent.key);
  const original = parent.forkOperation;
  forks.retire(parent);
  views.delete(parent.key);
  forks.retire(parent);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(parent.forkOperation).toBe(original);
  expect(original?.status).toBe("unknown");
  wire.channel.onmessage({
    kind: "forkResult",
    operationId: wire.operationId,
    settled: true,
    result: { ...result(wire), indexed: true },
  });
  await Promise.resolve();
  expect(original?.indexed).toBe(false);
});

it("successful handoff moves the same channel to the child, so retiring its source keeps child delivery alive", async () => {
  const { parent, forks, channels } = fixture();
  const dispose = vi.spyOn(SessionDeliveryObserver.prototype, "dispose");
  let wire!: Record<string, any>;
  h.invoke.mockImplementation(async (name, args) => {
    if (name !== "session_fork_current") return [];
    wire = args;
    const session = {
      cwd: wire.cwd,
      nativeSessionId: "child",
      connectionId: "child-owner",
      resumed: true,
      configOptions: [],
      configCheck: { status: "ready", issues: [], current: {} },
      warnings: [],
    };
    emitOpeningHeader(wire as any, session);
    wire.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "history" },
      },
    });
    wire.channel.onmessage({
      kind: "session_history_complete",
      openToken: wire.openToken,
    });
    return {
      ...result(wire),
      status: "ready",
      childSessionId: "child",
      indexed: true,
      session,
    };
  });
  const child = await forks.start(parent.key);
  expect(child).toBeDefined();
  forks.retire(parent);
  expect(dispose).not.toHaveBeenCalled();
  const raw = { sessionUpdate: "future_child", exact: [null, "live"] };
  wire.channel.onmessage({ update: raw });
  expect(
    child!.items.some((item) => item.kind === "raw" && item.update === raw),
  ).toBe(true);
  channels.delete(child!.key);
  expect(dispose).toHaveBeenCalledTimes(1);
});
