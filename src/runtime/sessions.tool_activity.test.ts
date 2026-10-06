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
import type { CompletionEvent } from "./completion";

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
function seed(id: string, end: CompletionEvent = { stopReason: "cancelled" }) {
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
    ...end,
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
  expect(groups[0]?.rows[0]).toMatchObject({
    status: "need",
    toolTailUnconfirmed: true,
  });
  expect(s.activeToolCallIds).toEqual(["tool"]);
  expect(threads.needsAttention(s)).toBe(false);
  channel.applyChannelEvent(s.key, {
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
    },
  });
  channel.applyChannelEvent(s.key, { kind: "toolActivity", toolCallIds: [] });
  const completed = groupSidebarRows([row(s.key)], new Map([[s.key, s]]), {
    archived: true,
  })[0]?.rows[0];
  expect(completed?.status).toBe("idle");
  expect(completed).not.toMatchObject({ toolTailUnconfirmed: true });
  expect(
    s.items.filter((i) => i.kind === "settled").map((i) => i.status),
  ).toEqual(["stopped"]);
});
it("shows a failed reply with unfinished official tools as an unknown result", () => {
  const s = seed("failed-tool-tail-sidebar", {
    failure: { category: "service" },
  });
  expect(s.items.at(-1)).toMatchObject({ kind: "settled", status: "failed" });
  expect(
    groupSidebarRows([row(s.key)], new Map([[s.key, s]]), {
      attentionOnly: true,
    })[0]?.rows[0],
  ).toMatchObject({ status: "need", toolTailUnconfirmed: true });
  expect(s.activeToolCallIds).toEqual(["tool"]);
  expect(s.queuePaused).toBe("failed");
});
it("keeps a normal end with official background tools in the running view", () => {
  const s = seed("background-tools-normal-end", { stopReason: "end_turn" });
  expect(s.items.at(-1)).toMatchObject({ kind: "settled", status: "done" });
  const background = groupSidebarRows([row(s.key)], new Map([[s.key, s]]))[0]
    ?.rows[0];
  expect(background?.status).toBe("run");
  expect(background).not.toMatchObject({ toolTailUnconfirmed: true });
});
it.each([
  "running",
  "submitting",
  "reconnecting",
  "configuring",
  "stopping",
  "new-message",
])("does not carry an older stopped tool warning into %s work", (next) => {
  const s = seed(`tool-tail-next-${next}`);
  if (next === "running") s.running = true;
  else if (next === "submitting") s.submitting = true;
  else if (next === "reconnecting") s.reconnecting = true;
  else if (next === "configuring") s.configuring = true;
  else if (next === "stopping") s.stopping = true;
  else
    s.items.push({
      kind: "user",
      id: "new-user",
      text: "New request",
      attachments: [],
      streaming: false,
      time: Date.now(),
    });
  const current = groupSidebarRows([row(s.key)], new Map([[s.key, s]]))[0]
    ?.rows[0];
  expect(current?.status).toBe("run");
  expect(current).not.toMatchObject({ toolTailUnconfirmed: true });
  expect(s.activeToolCallIds).toEqual(["tool"]);
});
it("does not replace a newer pending request with the previous tool warning", () => {
  const s = seed("tool-tail-next-approval");
  s.browserReadRequestId = "new-request";
  const pending = groupSidebarRows([row(s.key)], new Map([[s.key, s]]))[0]
    ?.rows[0];
  expect(pending?.status).toBe("need");
  expect(pending).not.toMatchObject({ toolTailUnconfirmed: true });
  expect(s.browserReadRequestId).toBe("new-request");
  expect(s.activeToolCallIds).toEqual(["tool"]);
});
it("rejects archive and permission mutation during the tool tail, but permits an explicit follow-up", async () => {
  const s = seed("tool-tail-guards");
  expect(
    groupSidebarRows([row(s.key)], new Map([[s.key, s]]))[0]?.rows[0].status,
  ).toBe("need");
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
  expect(s.activeToolCallIds).toEqual(["tool"]);
  const followUp = groupSidebarRows([row(s.key)], new Map([[s.key, s]]))[0]
    ?.rows[0];
  expect(followUp?.status).toBe("run");
  expect(followUp).not.toMatchObject({ toolTailUnconfirmed: true });
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
