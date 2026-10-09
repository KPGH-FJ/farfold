import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({
  expanded: false,
  invoke: vi.fn().mockResolvedValue(null),
}));
// These SSR cases deliberately request a collapsed/expanded initial view.
// Keep the real expansion model; its open state lives in a ref, while useState
// only requests a rerender. Globally forcing useState no longer sets it.
vi.mock("./transcript-search", async (original) => {
  const actual = await original<typeof import("./transcript-search")>();
  return {
    ...actual,
    useSearchExpansion: (initial = false) =>
      actual.useSearchExpansion(h.expanded || initial),
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import {
  threads,
  type ToolCallView,
  type ThreadState,
} from "../runtime/sessions";
import { ThreadView } from "./ThreadView";
import { ToolStep } from "./thread-items";
const channel = threads as unknown as {
  applyChannelEvent(key: string, event: unknown): void;
};
const options = [
  { optionId: "allow", kind: "allow_once", name: "Allow once" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
];
function state(id: string) {
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  s.running = true;
  return s;
}
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
const approval = (html: string) =>
  html.slice(
    html.indexOf('class="approval"'),
    html.indexOf('class="ap-actions"'),
  );
beforeEach(() => {
  h.expanded = false;
  h.invoke.mockClear();
  h.invoke.mockResolvedValue(null);
});
afterEach(() => {
  h.invoke.mockReset();
});

it("keeps the original approval visible and disabled until stop is confirmed", () => {
  const s = state("stop-approval");
  channel.applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "original",
    toolCall: {
      toolCallId: "call",
      title: "Original request",
      kind: "execute",
    },
    options,
  });
  const original = s.pendingPermissions[0];
  s.stopping = true;
  expect(render(s)).toContain('class="btn btn-primary" disabled=""');
  expect(s.pendingPermissions[0]).toBe(original);
  s.stopping = false;
  s.stopUnconfirmed = true;
  expect(render(s)).toContain('class="btn btn-primary" disabled=""');
  expect(approval(render(s))).toContain("停止结果未确认");
  expect(s.pendingPermissions[0].options).toEqual(options);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("shows the current request's complete command and cwd before approval buttons, preserving its original envelope", () => {
  const s = state("approval-input");
  const command = "touch '/tmp/approval file.txt' && printf '<review>'";
  const request = {
    sessionId: "approval-input",
    toolCall: {
      toolCallId: "call",
      kind: "execute",
      title: "Run command",
      status: "pending",
      rawInput: { command, cwd: "/tmp/execution folder" },
      futureToolField: { keep: true },
    },
    options,
    _meta: { future: { keep: "opaque" } },
    futureRequestField: 42,
  };
  const expected = structuredClone(request);
  channel.applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "first",
    toolCall: request.toolCall,
    options,
    request,
  });
  request.toolCall.rawInput.command = "echo mutated request";
  channel.applyChannelEvent(s.key, {
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call",
      rawInput: { command: "echo later live update", cwd: "/elsewhere" },
      title: "Later title",
    },
  });
  const html = approval(render(s));
  expect(html).toContain("touch &#x27;/tmp/approval file.txt&#x27;");
  expect(html).toContain("&lt;review&gt;");
  expect(html).toContain("/tmp/execution folder");
  expect(html).not.toContain("later live update");
  expect(html).not.toContain("mutated request");
  expect(s.pendingPermissions[0]).toMatchObject({
    toolCallSnapshot: expected.toolCall,
    requestSnapshot: expected,
  });
  expect(h.invoke).not.toHaveBeenCalled();
});

it("does not borrow an earlier request's input when a new approval for the same tool omits it", () => {
  const s = state("approval-no-inheritance");
  channel.applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "old",
    toolCall: {
      toolCallId: "reused",
      title: "Old",
      kind: "execute",
      rawInput: { command: "echo old approval" },
    },
    options,
  });
  channel.applyChannelEvent(s.key, { kind: "interactionsCancelled" });
  channel.applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "new",
    toolCall: { toolCallId: "reused", title: "Run command", kind: "execute" },
    options,
  });
  const html = render(s);
  expect(approval(html)).toContain("Agent 未提供本次操作的输入详情");
  expect(approval(html)).not.toContain("echo old approval");
  expect(s.pendingPermissions).toHaveLength(1);
  expect(s.pendingPermissions[0].options).toEqual(options);
});

it("keeps unknown input fully inspectable as escaped JSON without inventing command or directory fields", () => {
  const s = state("approval-unknown-input");
  channel.applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "unknown",
    toolCall: {
      toolCallId: "unknown",
      title: "Review operation",
      rawInput: { arguments: ["<unsafe-tag>", { deeply: "preserved-value" }] },
    },
    options,
  });
  const html = approval(render(s));
  expect(html).toContain("完整输入");
  expect(html).toContain("preserved-value");
  expect(html).toContain("&lt;unsafe-tag&gt;");
  expect(html).not.toContain("<unsafe-tag>");
  expect(html).not.toContain("执行目录");
});

it("offers and renders details for a tool whose only detail is raw input", () => {
  const call: ToolCallView = {
    toolCallId: "input-only",
    title: "Run command",
    kind: "execute",
    status: "pending",
    locations: [],
    content: [],
    startedAt: 1,
    rawInput: { command: "touch /tmp/input-only", cwd: "/tmp" },
  };
  const collapsed = renderToStaticMarkup(<ToolStep call={call} />);
  expect(collapsed).toContain('class="step-toggle"');
  expect(collapsed).toContain('aria-expanded="false"');
  h.expanded = true;
  const detail = renderToStaticMarkup(<ToolStep call={call} />);
  expect(detail).toContain('aria-expanded="true"');
  expect(detail).toContain("touch /tmp/input-only");
  expect(detail).toContain("执行目录");
});
