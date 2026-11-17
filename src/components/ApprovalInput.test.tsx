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
import { TranscriptSearchContext } from "./transcript-search";
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
const render = (thread: ThreadState, search = false) =>
  renderToStaticMarkup(
    <TranscriptSearchContext.Provider value={search}>
      <ThreadView
        thread={thread}
        active
        agents={[]}
        onGoSettings={() => {}}
        onOpened={() => {}}
      />
    </TranscriptSearchContext.Provider>,
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

it.each([
  ["input", { rawInput: { command: "later unconfirmed change" } }],
  ["output", { rawOutput: "later unconfirmed change" }],
  [
    "content",
    {
      content: [
        { type: "content", content: { type: "text", text: "later output" } },
      ],
    },
  ],
])(
  "shows separately reported input until the matching tool reports %s",
  (name, change) => {
    const s = state(`approval-reported-tool-${name}`);
    const toolCall = { toolCallId: "running" };
    const request = {
      sessionId: "fixture",
      toolCall,
      options,
      _meta: { opaque: 1 },
    };
    const reportedToolInput = {
      command: "printf 'linked fixture'",
      cwd: "/tmp/owned workspace",
    };
    channel.applyChannelEvent(s.key, {
      kind: "permissionRequest",
      requestId: "with-reported-input",
      toolCall,
      options,
      request,
      reportedToolInput,
    });
    expect(approval(render(s))).toContain("linked fixture");
    expect(approval(render(s))).toContain("/tmp/owned workspace");
    expect(s.pendingPermissions[0].requestSnapshot).toEqual(request);
    expect(s.pendingPermissions[0].toolCallSnapshot).toEqual(toolCall);

    channel.applyChannelEvent(s.key, {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "different",
        rawInput: { command: "unrelated" },
      },
    });
    expect(approval(render(s))).toContain("linked fixture");

    channel.applyChannelEvent(s.key, {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "running",
        ...change,
      },
    });
    const card = approval(render(s));
    expect(card).toContain("Agent 未提供本次操作的输入详情");
    expect(card).not.toMatch(/linked fixture|later unconfirmed change/);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("withdraws a queued remembered choice when matching tool output is accepted", async () => {
  vi.useFakeTimers();
  try {
    const s = state("approval-output-withdrawal");
    const requestId = "approval";
    channel.applyChannelEvent(s.key, {
      kind: "permissionRequest",
      requestId,
      toolCall: { toolCallId: "tool" },
      options: [
        { optionId: "remember", name: "Remember", kind: "allow_always" },
      ],
      reportedToolInput: { command: "fixture input" },
    });
    threads.decidePermission(
      s.key,
      requestId,
      "remember",
      "Remember",
      true,
      true,
    );
    expect(s.pendingPermissions[0].decision?.undoable).toBe(true);

    const output = {
      kind: "toolOutput",
      toolCallId: "tool",
      source: "reported",
      data: "fixture output",
      truncated: false,
    };
    channel.applyChannelEvent(s.key, { ...output, sequence: 0 });
    expect(s.pendingPermissions[0].decision?.undoable).toBe(true);
    channel.applyChannelEvent(s.key, { ...output, sequence: 1 });
    expect(s.pendingPermissions[0].decision).toBeNull();
    expect(approval(render(s))).toContain("Agent 未提供本次操作的输入详情");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.invoke).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("withdraws reported input when another approval reuses that tool ID", () => {
  const s = state("approval-reused-tool-id");
  const event = {
    kind: "permissionRequest",
    toolCall: { toolCallId: "shared" },
    options,
  };
  channel.applyChannelEvent(s.key, {
    ...event,
    requestId: "first",
    reportedToolInput: { command: "initial fixture input" },
  });
  expect(approval(render(s))).toContain("initial fixture input");
  channel.applyChannelEvent(s.key, { ...event, requestId: "next" });
  expect(render(s)).not.toContain("initial fixture input");
  expect(s.pendingPermissions).toHaveLength(2);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("shows an owned command's exact program, argv boundaries, and directory before its one-time choices", () => {
  const s = state("terminal-approval");
  const command = {
    program: "/tmp/test tools/print",
    args: ["<review tag>", "", " leading", "first\nsecond", "a\u202eb"],
    cwd: "/tmp/test workspace",
  };
  channel.applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "terminal",
    terminalCommand: command,
    options,
  });
  command.args[0] = "later edit";
  const html = render(s);
  const card = approval(html);
  expect(card).toContain("程序");
  expect(card).toContain("&quot;/tmp/test tools/print&quot;");
  expect(card).toContain("参数");
  expect(card).toContain("<code>&quot;&lt;review tag&gt;&quot;\n</code>");
  expect(card).toContain("<code>&quot;&quot;\n</code>");
  expect(card).toContain("<code>&quot; leading&quot;\n</code>");
  expect(card).toContain("<code>&quot;first\\nsecond&quot;\n</code>");
  expect(card).toContain("<code>&quot;a\\u{202e}b&quot;</code>");
  expect(card).toContain("执行目录");
  expect(card).toContain("&quot;/tmp/test workspace&quot;");
  expect(card).not.toMatch(/later edit|<review tag>|\u202e|Agent 未提供/);
  expect(html).toContain("批准一次");
  expect(html).toContain("拒绝");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("distinguishes zero arguments from one empty argument", () => {
  const s = state("terminal-no-arguments");
  channel.applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "terminal",
    terminalCommand: { program: "/usr/bin/true", args: [], cwd: "/tmp" },
    options,
  });
  expect(approval(render(s))).toContain("无参数");
});

it.each([null, { program: "/usr/bin/true", args: [null], cwd: "/tmp" }])(
  "does not use Agent input to fill incomplete owned command details",
  (terminalCommand) => {
    const s = state(
      terminalCommand ? "terminal-invalid-args" : "terminal-null",
    );
    channel.applyChannelEvent(s.key, {
      kind: "permissionRequest",
      requestId: "terminal",
      terminalCommand,
      toolCall: {
        toolCallId: "wrong-source",
        rawInput: { command: "unrelated-command" },
      },
      options,
    });
    const html = render(s);
    expect(approval(html)).toContain("无法核对这次命令的完整信息");
    expect(approval(html)).not.toContain("unrelated-command");
    expect(html).not.toContain("批准一次");
    expect(
      s.pendingPermissions[0].options.map((option) => option.kind),
    ).toEqual(["reject_once"]);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("does not offer allow when an owned command advertises a persistent choice sharing an ID", () => {
  const s = state("terminal-ambiguous-options");
  channel.applyChannelEvent(s.key, {
    kind: "permissionRequest",
    requestId: "terminal",
    terminalCommand: { program: "/usr/bin/true", args: [], cwd: "/tmp" },
    options: [...options, { ...options[1], kind: "allow_always" }],
  });
  expect(s.pendingPermissions[0].options).toEqual([]);
  expect(render(s)).not.toContain("批准一次");
  expect(h.invoke).not.toHaveBeenCalled();
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
  const collapsed = approval(render(s));
  expect(collapsed).toContain("完整输入");
  expect(collapsed).not.toContain("preserved-value");
  expect(collapsed).not.toContain("<pre");
  const html = approval(render(s, true));
  expect(html).not.toContain('open=""');
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
