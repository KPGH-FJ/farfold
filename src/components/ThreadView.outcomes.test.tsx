import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "../runtime/session_projection";
import { threads, type ThreadState } from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { ThreadView } from "./ThreadView";
import { ApprovalCard } from "./thread-items";

const render = (thread: ThreadState) =>
  renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
afterEach(() => {
  vi.useRealTimers();
  invoke.mockClear();
});

it("shows an empty normal ending without a success mark or invented failure", () => {
  const s = freshThreadState("a:/p:empty-view", "a", "/p", "empty-view");
  applyTurnEnd(s, { stopReason: "end_turn" });
  const html = render(s);
  expect(html).toContain(STRINGS.thread.noResult);
  expect(html).toContain(STRINGS.thread.noResultNote);
  const settled = html.match(/<div class="settled">[\s\S]*?<\/div>/g);
  expect(settled).toHaveLength(1);
  expect(settled![0]).toContain(STRINGS.thread.noResult);
  expect(settled![0]).not.toContain(STRINGS.thread.done);
  expect(html).not.toContain(STRINGS.repair.requestFailed);
});

it("shows a tool-only terminal result as ended and retains a failed tool's own status", () => {
  const s = freshThreadState("a:/p:tool-view", "a", "/p", "tool-view");
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    status: "failed",
    title: "An actual failed tool",
  });
  applyTurnEnd(s, { stopReason: "end_turn" });
  const html = render(s);
  expect(html).toContain(STRINGS.thread.ended);
  expect(html).not.toContain(STRINGS.thread.noResult);
  const settled = html.match(/<div class="settled">[\s\S]*?<\/div>/g);
  expect(settled).toHaveLength(1);
  expect(settled![0]).toContain(STRINGS.thread.ended);
  expect(settled![0]).not.toContain(STRINGS.thread.done);
  expect(s.items.find((item) => item.kind === "tool")?.call.status).toBe(
    "failed",
  );
});

it("replaces only the original round's pending result once a real tail result arrives", () => {
  const s = freshThreadState("a:/p:pending-view", "a", "/p", "pending-view");
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    status: "in_progress",
  });
  s.activeToolCallIds = ["tool"];
  applyTurnEnd(s, { stopReason: "end_turn" });
  expect(render(s)).toContain(STRINGS.thread.resultPending);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool",
    status: "completed",
  });
  s.activeToolCallIds = [];
  expect(render(s)).not.toContain(STRINGS.thread.resultPending);
  expect(render(s)).toContain(STRINGS.thread.ended);
  expect(s.queuePaused).toBe("stopped");
});

it("shows the Agent's actual option name instead of inferring the remembered scope", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      title="Command"
      kind="execute"
      locations={[]}
      onPick={() => {}}
      options={[
        {
          optionId: "prefix-rule",
          kind: "allow_always",
          name: "Allow the suggested command prefix",
        },
      ]}
    />,
  );
  expect(html).toContain(STRINGS.thread.approveRemember);
  expect(html).toContain("Allow the suggested command prefix");
  expect(html).not.toContain("本次会话内不再询问");
});

it("does not claim approval while its remember decision is still undoable", () => {
  vi.useFakeTimers();
  const s = threads.markOpenFailed(
    "a:/p:pending-decision",
    "a",
    "/p",
    "pending-decision",
    "fixture",
  );
  s.openError = null;
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "remember",
    toolCall: { toolCallId: "tool", title: "Command" },
    options: [
      { optionId: "exact", kind: "allow_always", name: "Agent supplied scope" },
    ],
  });
  threads.decidePermission(
    s.key,
    "remember",
    "exact",
    STRINGS.thread.approvedRemember("Agent supplied scope"),
    true,
    true,
  );
  const html = render(s);
  expect(html).toContain(STRINGS.thread.decisionWaiting);
  expect(html).not.toContain("已批准");
  expect(
    invoke.mock.calls.some(
      ([command]) => command === "session_permission_respond",
    ),
  ).toBe(false);
  threads.undoPermissionDecision(s.key, "remember");
  expect(s.pendingPermissions[0].decision).toBeNull();
});
