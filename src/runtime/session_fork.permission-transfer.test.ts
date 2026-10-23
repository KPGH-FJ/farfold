import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
import { SessionForks } from "./session_fork";
import { freshThreadState } from "./session_projection";
import { draftPersistence } from "./drafts";
import { emitOpeningHeader } from "./session_open_test_fixture";
import { SessionChannels } from "./session_channels";
import type { ThreadState } from "./session_types";
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it.each([true, false])(
  "fork permission changes transfer only with an accepted same-state installation (readable=%s)",
  async (readable) => {
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
    const install = vi.fn((state, channel, permissionChanges: number) => {
      expect(permissionChanges).toBe(2);
      views.set(state.key, state);
      channels.set(state.key, channel);
    });
    const forks = new SessionForks({
      thread: (key) => views.get(key),
      rows: () => [],
      install,
      ownsChannel: (key, channel) => channels.get(key) === channel,
      apply: () => {},
      emit: () => {},
      refreshIndex: async () => {},
    });
    h.invoke.mockImplementation(async (name, wire) => {
      if (name !== "session_fork_current") return [];
      const session = {
        cwd: wire.cwd,
        nativeSessionId: "child",
        connectionId: "child-owner",
        resumed: true,
        configOptions: [],
        warnings: [],
        configCheck: { status: "ready", issues: [], current: {} },
      };
      emitOpeningHeader(wire, session);
      if (readable)
        wire.channel.onmessage({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "owned history" },
          },
        });
      for (const permissionState of ["unknown", "required"])
        wire.channel.onmessage({ kind: "permissionState", permissionState });
      expect(install).not.toHaveBeenCalled();
      wire.channel.onmessage({
        kind: "session_history_complete",
        openToken: wire.openToken,
      });
      return {
        status: "ready",
        operationId: wire.operationId,
        parentConnectionId: wire.connectionId,
        parentSessionId: wire.parentSessionId,
        cwd: wire.cwd,
        childSessionId: "child",
        sourceReleased: true,
        indexed: true,
        session,
      };
    });
    const state = await forks.start(parent.key);
    if (readable) {
      expect(install).toHaveBeenCalledTimes(1);
      expect(install.mock.calls[0][0]).toBe(state);
      expect(state?.permissionState).toBe("required");
      expect(views.get("a:/owned:child")).toBe(state);
      channels.delete(state!.key);
    } else {
      expect(install).not.toHaveBeenCalled();
      expect(state).toBeUndefined();
      forks.retire(parent);
    }
  },
);
