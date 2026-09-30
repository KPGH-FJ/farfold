import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  freshThreadState,
  applyUpdate,
  applyTurnEnd,
  applyConnectionLost,
} from "../runtime/sessions";
import { ThreadView } from "./ThreadView";

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
