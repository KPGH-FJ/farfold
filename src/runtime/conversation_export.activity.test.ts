import { expect, it } from "vitest";
import {
  applyConnectionLost,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import { captureConversationExport } from "./conversation_archive_snapshot";
import { artifactPaneCards } from "./artifact_view";
import { transcriptMarkdown } from "./conversation_export";
import { EXPORT_STRINGS as E } from "./export_strings";
import { applySessionEvent } from "./session_event_projection";
import { paneCards } from "./artifacts";
import { toolActivityState, type ThreadState } from "./session_types";

function subject() {
  const s = freshThreadState("export-activity", "fixture", "/work", "native");
  s.running = true;
  s.connectionId = "current";
  s.activeToolCallIds = ["tool"];
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    kind: "execute",
    status: "in_progress",
    rawInput: { private: "PRIVATE_INPUT" },
    content: [
      { type: "content", content: { type: "text", text: "RECEIVED_BODY" } },
    ],
  });
  return s;
}
it.each([
  "disconnected",
  "unqualifiedHistory",
  "otherConnection",
  "absentActivity",
])(
  "captures %s tool activity as unconfirmed without rewriting the native result",
  (kind) => {
    const s = subject();
    if (kind === "disconnected") applyConnectionLost(s);
    if (kind === "unqualifiedHistory")
      s.historyUnavailable = { reason: "incomplete", sourceKnown: true };
    if (kind === "otherConnection")
      s.historyUnavailable = {
        reason: "incomplete",
        sourceKnown: true,
        toolActivityConnectionId: "former",
      };
    if (kind === "absentActivity") s.activeToolCallIds = [];
    const before = structuredClone(s.items);
    const snapshot = captureConversationExport(s, "Own", "Fixture");
    for (const text of [
      snapshot.markdown,
      snapshot.archiveMarkdown,
      snapshot.detailedMarkdown,
      snapshot.detailedArchiveMarkdown,
    ]) {
      expect(text).toContain(`（${E.unknown}）`);
      expect(text).not.toContain("（进行中）");
      expect(text).not.toContain("PRIVATE_INPUT");
    }
    expect(snapshot.detailedMarkdown).toContain("RECEIVED_BODY");
    expect(s.items).toEqual(before);
  },
);
it("keeps the confirmed active snapshot frozen after later disconnection", () => {
  const s = subject();
  const snapshot = captureConversationExport(s, "Own", "Fixture");
  expect(snapshot.markdown).toContain("（进行中）");
  applyConnectionLost(s);
  expect(transcriptMarkdown(s, "Own", "Fixture")).toContain(`（${E.unknown}）`);
  expect(snapshot.markdown).toContain("（进行中）");
});

it("does not infer active work from an unfinished call without current activity evidence", () => {
  const s = subject();
  expect(transcriptMarkdown({ items: s.items }, "Own", "Fixture")).toContain(
    `（${E.unknown}）`,
  );
});
it("retains activity confirmed by the current connection during partial history delivery", () => {
  const s = subject();
  s.historyUnavailable = {
    reason: "incomplete",
    sourceKnown: true,
    toolActivityConnectionId: "current",
  };
  expect(captureConversationExport(s, "Own", "Fixture").markdown).toContain(
    "（进行中）",
  );
});
it.each(["completed", "failed"])(
  "retains the actual %s result after disconnection",
  (status) => {
    const s = subject();
    applyUpdate(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status,
    });
    applyConnectionLost(s);
    expect(captureConversationExport(s, "Own", "Fixture").markdown).toContain(
      `（${E.status[status as "completed" | "failed"]}）`,
    );
  },
);
it("shares the declared file-operation label without exporting raw or proposed input bodies", () => {
  const s = subject();
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool",
    kind: "other",
    status: "failed",
    rawInput: {
      path: "/work/file.txt",
      previous: "PRIVATE_PROPOSED_BEFORE",
      replacement: "PRIVATE_PROPOSED_AFTER",
    },
  });
  applySessionEvent(
    s,
    {
      kind: "toolFileInput",
      source: "reported",
      toolCallId: "tool",
      fields: {
        operation: "edit",
        path: "path",
        oldText: "previous",
        newText: "replacement",
      },
    },
    false,
  );
  const snapshot = captureConversationExport(s, "Own", "Fixture");
  expect(snapshot.detailedMarkdown).toContain("- 修改（失败）");
  expect(snapshot.detailedMarkdown).not.toContain("PRIVATE_PROPOSED");
  expect(snapshot.detailedMarkdown).toContain("工具输入与拟写入内容");
});

function beginTool(
  s: ThreadState,
  toolCallId: string,
  status: "pending" | "in_progress" = "in_progress",
) {
  s.running = true;
  s.roundItemBase = s.items.length;
  applySessionEvent(
    s,
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: toolCallId,
        kind: "execute",
        status,
      },
    },
    true,
  );
  applySessionEvent(
    s,
    { kind: "toolActivity", toolCallIds: [...s.activeToolCallIds, toolCallId] },
    true,
  );
}

function renderToolStates(s: ThreadState) {
  return s.items.flatMap((item) =>
    item.kind === "tool" ? [toolActivityState(s, item.call)] : [],
  );
}

function finishTool(
  s: ThreadState,
  toolCallId: string,
  status: "completed" | "failed",
) {
  applySessionEvent(
    s,
    { update: { sessionUpdate: "tool_call_update", toolCallId, status } },
    true,
  );
  applySessionEvent(
    s,
    {
      kind: "toolActivity",
      toolCallIds: s.activeToolCallIds.filter((id) => id !== toolCallId),
    },
    true,
  );
}

it.each([
  ["pending", "completed"],
  ["in_progress", "failed"],
] as const)(
  "shows a cancelled round's %s tool as unknown across exports and cards until its own %s receipt",
  (status, terminal) => {
    const s = freshThreadState("stopped-export", "fixture", "/work", "native");
    s.connectionId = "current";
    beginTool(s, "stopped-tool", status);
    expect(renderToolStates(s)).toEqual(["active"]);
    expect(paneCards(s).map((card) => card.status)).toEqual([status]);
    expect(transcriptMarkdown(s, "Own", "Fixture")).toContain(
      `（${E.status[status]}）`,
    );

    applySessionEvent(s, { kind: "turnEnd", stopReason: "cancelled" }, true);
    expect(s.items.at(-1)).toMatchObject({
      kind: "settled",
      status: "stopped",
      stopReason: "cancelled",
    });
    expect(s.items.find((item) => item.kind === "tool")?.call.status).toBe(
      status,
    );
    const rawBeforeRead = structuredClone(s.items);
    const stepId = s.items.find((item) => item.kind === "tool")!.id;
    const stoppedRoundId = s.items.at(-1)!.id;
    const snapshot = captureConversationExport(s, "Own", "Fixture");
    expect.soft(renderToolStates(s)).toEqual(["unknown"]);
    expect.soft(paneCards(s).map((card) => card.status)).toEqual(["unknown"]);
    for (const target of [stepId, stoppedRoundId])
      expect
        .soft(artifactPaneCards(s, target)?.map((card) => card.status))
        .toEqual(["unknown"]);
    for (const text of [
      snapshot.markdown,
      snapshot.archiveMarkdown,
      snapshot.detailedMarkdown,
      snapshot.detailedArchiveMarkdown,
    ]) {
      expect.soft(text).toContain(`（${E.unknown}）`);
      expect.soft(text).not.toContain(`（${E.status[status]}）`);
    }
    expect(s.items).toEqual(rawBeforeRead);
    expect(s.activeToolCallIds).toEqual(["stopped-tool"]);

    finishTool(s, "stopped-tool", terminal);
    expect(renderToolStates(s)).toEqual(["finished"]);
    expect(paneCards(s).map((card) => card.status)).toEqual([terminal]);
    for (const target of [stepId, stoppedRoundId])
      expect(artifactPaneCards(s, target)?.map((card) => card.status)).toEqual([
        terminal,
      ]);
    expect(transcriptMarkdown(s, "Own", "Fixture")).toContain(
      `（${E.status[terminal]}）`,
    );
    expect(s.items.find((item) => item.kind === "tool")?.call.status).toBe(
      terminal,
    );
    expect(s.items.filter((item) => item.kind === "settled")).toMatchObject([
      { status: "stopped", stopReason: "cancelled" },
    ]);
  },
);

it("keeps the cancelled tool unknown during other rounds and isolates a sibling reusing its tool ID", () => {
  const a = freshThreadState("owner-a", "fixture", "/work", "a");
  a.connectionId = "connection-a";
  beginTool(a, "background");
  applySessionEvent(a, { kind: "turnEnd", stopReason: "end_turn" }, true);
  beginTool(a, "shared-id", "pending");
  applySessionEvent(a, { kind: "turnEnd", stopReason: "cancelled" }, true);
  beginTool(a, "new-round");

  const b = freshThreadState("owner-b", "fixture", "/work", "b");
  b.connectionId = "connection-b";
  beginTool(b, "shared-id", "pending");
  expect(renderToolStates(b)).toEqual(["active"]);
  expect(paneCards(b).map((card) => card.status)).toEqual(["pending"]);
  expect(transcriptMarkdown(b, "Own B", "Fixture")).toContain(
    `（${E.status.pending}）`,
  );

  finishTool(a, "background", "completed");
  finishTool(b, "shared-id", "completed");
  expect.soft(renderToolStates(a)).toEqual(["finished", "unknown", "active"]);
  expect
    .soft(paneCards(a).map((card) => card.status))
    .toEqual(["completed", "unknown", "in_progress"]);
  const markdown = transcriptMarkdown(a, "Own A", "Fixture");
  expect.soft(markdown).toContain(`（${E.unknown}）`);
  expect.soft(markdown).not.toContain(`（${E.status.pending}）`);
  expect(markdown).toContain(`（${E.status.in_progress}）`);
  expect(markdown).toContain(`（${E.status.completed}）`);
  expect(renderToolStates(b)).toEqual(["finished"]);
  expect(a.activeToolCallIds).toEqual(["shared-id", "new-round"]);
});
