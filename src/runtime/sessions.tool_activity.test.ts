import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, groupSidebarRows, type IndexRow } from "./sessions";
import { draftPersistence } from "./drafts";

const channel = threads as unknown as {
  applyChannelEvent(key: string, event: unknown): void;
};
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  invoke.mockImplementation(async (command: string) =>
    command === "session_prompt"
      ? { status: "accepted" }
      : command === "settings_get"
        ? null
        : [],
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
});
function seed(id: string) {
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  s.running = true;
  channel.applyChannelEvent(s.key, {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "Sleep",
      kind: "execute",
      status: "in_progress",
    },
  });
  channel.applyChannelEvent(s.key, {
    kind: "toolActivity",
    toolCallIds: ["tool"],
  });
  channel.applyChannelEvent(s.key, {
    kind: "turnEnd",
    stopReason: "cancelled",
  });
  return s;
}
function row(id: string): IndexRow {
  return {
    id,
    agentId: "a",
    cwd: "/p",
    nativeSessionId: "s",
    title: "Test",
    pinned: false,
    archived: true,
    createdAt: 1,
    updatedAt: 1,
    configOptions: null,
  };
}
it("keeps stopped replies with official unfinished tools active and reachable until terminal receipt", () => {
  const s = seed("tool-tail-sidebar");
  expect(s.running).toBe(false);
  expect(s.items.find((i) => i.kind === "tool")?.call.status).toBe(
    "in_progress",
  );
  const groups = groupSidebarRows([row(s.key)], new Map([[s.key, s]]), {
    autoArchiveDays: 1,
  });
  expect(groups[0]?.rows[0].status).toBe("run");
  channel.applyChannelEvent(s.key, {
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
    },
  });
  channel.applyChannelEvent(s.key, { kind: "toolActivity", toolCallIds: [] });
  expect(
    groupSidebarRows([row(s.key)], new Map([[s.key, s]]), { archived: true })[0]
      ?.rows[0].status,
  ).toBe("idle");
  expect(
    s.items.filter((i) => i.kind === "settled").map((i) => i.status),
  ).toEqual(["stopped"]);
});
it("rejects archive and permission mutation during the tool tail, but permits an explicit follow-up", async () => {
  const s = seed("tool-tail-guards");
  s.permissionConfigId = "mode";
  await expect(threads.setArchived(s.key, true)).rejects.toBeTruthy();
  await expect(threads.setConfig(s.key, "mode", "ask")).rejects.toBeTruthy();
  expect(
    invoke.mock.calls.some(
      ([command]) =>
        command === "session_set_config" || command === "session_meta_archive",
    ),
  ).toBe(false);
  expect(
    await threads.send(s.key, [{ type: "text", text: "Continue" }]),
  ).toEqual({ status: "accepted" });
  expect(
    invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(true);
});
it("does not interpret an unfinished replayed status as a newly executing tool", () => {
  const s = seed("tool-replay");
  channel.applyChannelEvent(s.key, { kind: "toolActivity", toolCallIds: [] });
  const saved = { ...row(s.key), archived: false };
  expect(
    groupSidebarRows([saved], new Map([[s.key, s]]))[0]?.rows[0].status,
  ).toBe("idle");
  expect(s.items.find((i) => i.kind === "tool")?.call.status).toBe(
    "in_progress",
  );
});
it.each([undefined, "process_ended"])(
  "retains an honest unknown result after tool-tail connection loss (%s)",
  (reason) => {
    const s = seed(`tool-tail-lost-${reason}`);
    if (reason)
      channel.applyChannelEvent(s.key, {
        kind: "toolActivity",
        toolCallIds: [],
        reason,
      });
    channel.applyChannelEvent(s.key, { kind: "connectionLost" });
    expect(s.connectionOutcomeUnknown).toBe(true);
    expect(threads.needsAttention(s)).toBe(true);
    expect(
      groupSidebarRows([row(s.key)], new Map([[s.key, s]]))[0]?.rows[0].status,
    ).toBe("need");
    expect(s.items.find((i) => i.kind === "tool")?.call.status).toBe(
      "in_progress",
    );
  },
);
