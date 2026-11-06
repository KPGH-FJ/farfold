import { beforeEach, expect, it, vi } from "vitest";
const work = vi.hoisted(() => ({ ready: true, enabled: true }));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({
    ready: work.ready,
    enabled: () => work.enabled,
    saving: false,
  }),
}));
import { renderToStaticMarkup } from "react-dom/server";
import {
  freshThreadState,
  applyUpdate,
  applyTurnEnd,
  applyConnectionLost,
} from "../runtime/sessions";
import { ThreadView } from "./ThreadView";
import { composerDrafts } from "../runtime/drafts";

beforeEach(() => {
  work.ready = true;
  work.enabled = true;
  composerDrafts.update("session:a:/p:tools", () => ({
    text: "",
    attachments: [],
  }));
  composerDrafts.update("queue-edit:a:/p:tools", () => ({
    text: "",
    attachments: [],
  }));
});

function state() {
  const thread = freshThreadState("a:/p:tools", "a", "/p", "tools");
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "t",
    title: "Sleep",
    kind: "execute",
    status: "in_progress",
  });
  Object.assign(thread, { activeToolCallIds: ["t"] });
  applyTurnEnd(thread, { stopReason: "cancelled" });
  return thread;
}
const render = (thread: ReturnType<typeof state>) =>
  renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
it("distinguishes a stopped reply from still active official steps and clears the note only on terminal activity", () => {
  const thread = state();
  const html = render(thread);
  expect(html).toContain("回复已停止，仍有步骤未确认结束");
  expect(html).toContain("正在处理");
  expect(html).toContain('class="g run"');
  applyUpdate(thread, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    status: "completed",
  });
  Object.assign(thread, { activeToolCallIds: [] });
  const done = render(thread);
  expect(done).not.toContain("回复已停止，仍有步骤未确认结束");
  expect(done).toContain('class="g ok"');
});
it("does not animate historical or disconnected unfinished steps as currently executing", () => {
  const thread = state();
  applyConnectionLost(thread);
  const lost = render(thread);
  expect(lost).not.toContain('class="g run"');
  expect(lost).toContain("步骤结果未知");
  const replay = state();
  Object.assign(replay, { activeToolCallIds: [] });
  const history = render(replay);
  expect(history).not.toContain("正在处理");
  expect(history).not.toContain('class="g run"');
  expect(history).toContain("步骤结果未知");
});
it("describes an officially pending step as waiting without changing its status", () => {
  const thread = state();
  applyUpdate(thread, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    status: "pending",
  });
  const html = render(thread);
  expect(html).toContain("等待处理");
  expect(html).not.toContain("正在处理");
  expect(html).not.toContain('class="g run"');
  expect(html).toContain("回复已停止，仍有步骤未确认结束");
});

it("offers a check on the stopped live owner without offering an immediate close", () => {
  const thread = state();
  thread.connectionId = "owner";
  thread.identity = "established";
  const html = render(thread);
  expect(html).toContain("检查能否关闭此对话的连接");
  expect(html).not.toContain(">关闭此对话的连接</button>");
  thread.stopUnconfirmed = true;
  expect(render(thread)).not.toContain("检查能否关闭此对话的连接");
});

it("explains the explicit queue path only for a failed reply whose new input can be staged", () => {
  const failed = () => {
    const thread = state();
    thread.identity = "established";
    applyTurnEnd(thread, { failure: { category: "service" } });
    return thread;
  };
  const hint = "新消息会先加入待发；检查后点“继续发送”。";
  const thread = failed();
  const before = structuredClone(thread);
  expect(render(thread)).toContain(hint);
  expect(thread).toEqual(before);

  const blocked: Partial<ReturnType<typeof state>>[] = [
    { running: true },
    { submitting: true },
    { reconnecting: true },
    { configuring: true },
    { configError: "check failed" },
    { stopping: true },
    { stopUnconfirmed: true },
    { connectionOutcomeUnknown: true },
    { connectionLost: true },
    { browserReadRequestId: "browser-approval" },
    { uncertainPrompt: [{ type: "text", text: "unknown input" }] },
    { permissionConfigId: "permission", permissionState: "required" },
    { modelDrift: true },
    { openError: "read failed" },
    { workEnabled: false },
    { queued: [[{ type: "text", text: "already queued" }]] },
    { activeToolCallIds: [] },
  ];
  for (const changes of blocked)
    expect(render(Object.assign(failed(), changes))).not.toContain(hint);
  expect(render(state())).not.toContain(hint);
  const done = failed();
  applyTurnEnd(done, { stopReason: "end_turn" });
  expect(render(done)).not.toContain(hint);

  work.ready = false;
  expect(render(failed())).not.toContain(hint);
  work.ready = true;
  work.enabled = false;
  expect(render(failed())).not.toContain(hint);
  work.enabled = true;
  composerDrafts.update("session:a:/p:tools", (draft) => ({
    ...draft,
    text: "input awaiting confirmation",
    sendPending: true,
  }));
  expect(render(failed())).not.toContain(hint);
});
