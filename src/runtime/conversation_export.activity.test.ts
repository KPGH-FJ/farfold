import { expect, it } from "vitest";
import {
  applyConnectionLost,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import { captureConversationExport } from "./conversation_archive_snapshot";
import { transcriptMarkdown } from "./conversation_export";
import { EXPORT_STRINGS as E } from "./export_strings";
import { applySessionEvent } from "./session_event_projection";

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
