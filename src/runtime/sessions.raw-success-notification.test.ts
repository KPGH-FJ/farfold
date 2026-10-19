import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), sequence: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

import { threads } from "./sessions";
import { draftPersistence } from "./drafts";
import { archiveActivity } from "./archive_activity";
import type { ThreadState } from "./session_types";

function event(state: ThreadState, value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, value: unknown): void;
    }
  ).applyChannelEvent(state.key, value);
}

beforeEach(() => {
  vi.stubGlobal("document", { hidden: true, hasFocus: () => false });
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  h.invoke.mockImplementation(async (command: string) => {
    if (command === "session_prompt") return { status: "accepted" };
    if (command === "desktop_notifications_get")
      return {
        enabled: false,
        successEnabled: true,
        sound: false,
        permission: "authorized",
        systemAlert: true,
        systemSound: true,
        clickRequiresRunning: false,
      };
    if (command === "desktop_notification_submit") return "submitted";
    return command === "session_index_list" ? [] : null;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  h.invoke.mockReset();
});

it.each(["failed", "completed"] as const)(
  "real send remembers initial tool %s despite synchronous raw replacement",
  async (initialStatus) => {
    const id = `raw-success-${++h.sequence}`;
    const state = threads.markOpenFailed(
      id,
      "controlled",
      "/owned",
      id,
      "fixture",
    );
    state.openError = null;
    state.identity = "established";
    state.connectionId = `connection-${id}`;
    expect(
      await threads.send(state.key, [
        { type: "text", text: "Controlled input" },
      ]),
    ).toEqual({ status: "accepted" });
    expect(
      h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
    ).toHaveLength(1);
    expect(state.running).toBe(true);
    expect(state.activeToolCallIds).toEqual([]);
    // No awaits between receipt and replacement: observe must capture the failed
    // projected state before the next update overwrites the same tool identity.
    event(state, {
      ...(initialStatus === "completed"
        ? { kind: "connectionLost", closeReason: "unexpected" }
        : {}),
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "same-tool",
        title: "Controlled tool",
        kind: "read",
        status: initialStatus,
      },
    });
    event(state, {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "same-tool",
        status: "completed",
      },
    });
    event(state, {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Controlled result" },
      },
    });
    event(state, { kind: "turnEnd", stopReason: "end_turn" });
    for (let n = 0; n < 16; n++) await Promise.resolve();
    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" && tool.call.status).toBe("completed");
    expect(
      state.items.some(
        (item) => item.kind === "settled" && item.status === "done",
      ),
    ).toBe(true);
    expect(state.connectionLost).toBe(false);
    const submitted = h.invoke.mock.calls.filter(
      ([command]) => command === "desktop_notification_submit",
    );
    expect(submitted).toHaveLength(initialStatus === "failed" ? 0 : 1);
    if (submitted.length)
      expect(submitted[0][1]).toMatchObject({
        kind: "success",
        targetKey: state.key,
      });
    await threads.close(state.key);
  },
);
