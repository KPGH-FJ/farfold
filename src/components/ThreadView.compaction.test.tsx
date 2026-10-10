import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import {
  applyConnectionLost,
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "../runtime/session_projection";
import { STRINGS } from "../runtime/strings";
import { COMPACTION } from "../runtime/compaction_strings";
import { ThreadView } from "./ThreadView";

const state = () => freshThreadState("a:/p:c", "a", "/p", "c");
const render = (s: ReturnType<typeof state>) =>
  renderToStaticMarkup(
    <ThreadView
      thread={s}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
it.each([
  ["in_progress", "正在整理上下文"],
  ["completed", "上下文已整理"],
  ["failed", "上下文整理失败"],
  ["cancelled", "上下文整理已取消"],
  ["_future", "上下文整理状态待确认"],
])("shows the actual %s lifecycle state in a shared card", (status, label) => {
  const s = state();
  applyUpdate(s, {
    sessionUpdate: "compaction_update",
    compactionId: "c",
    status,
  });
  expect(render(s)).toContain(label);
});
it("renders an accessible retained summary, non-text blocks and original details without a fake reply", () => {
  const s = state();
  applyUpdate(s, {
    sessionUpdate: "compaction_update",
    compactionId: "c",
    status: "completed",
    summary: [
      { type: "text", text: "**Retained summary**" },
      {
        type: "resource_link",
        name: "output",
        uri: "https://example.com/result",
      },
    ],
    _meta: { future: "preserved" },
  });
  applyTurnEnd(s, { stopReason: "end_turn" });
  const html = render(s);
  expect(html).toContain("<summary");
  expect(html).toContain("保留的摘要");
  expect(html).toContain("<strong>Retained summary</strong>");
  expect(html).toContain("https://example.com/result");
  expect(html).toContain("preserved");
  expect(html).not.toContain(STRINGS.thread.noResultNote);
  const settled = html.match(/<div class="settled">[\s\S]*?<\/div>/g);
  expect(settled).toHaveLength(1);
  expect(settled![0]).toContain(COMPACTION.roundCompleted);
  expect(settled![0]).not.toContain(STRINGS.thread.done);
});
it("labels partial failed content and connection loss honestly", () => {
  const s = state();
  applyUpdate(s, {
    sessionUpdate: "compaction_update",
    compactionId: "c",
    status: "in_progress",
  });
  applyUpdate(s, {
    sessionUpdate: "compaction_summary_chunk",
    compactionId: "c",
    content: { type: "text", text: "partial" },
  });
  applyConnectionLost(s);
  expect(render(s)).toContain("上下文整理结果未知");
  expect(render(s)).toContain("未完成的摘要");
  expect(render(s)).not.toContain("保留的摘要");
  applyUpdate(s, {
    sessionUpdate: "compaction_update",
    compactionId: "c",
    status: "failed",
    error: "actual refusal",
  });
  expect(render(s)).toContain("actual refusal");
});

it("joins adjacent streamed text blocks into the same retained Markdown content", () => {
  const s = state();
  applyUpdate(s, {
    sessionUpdate: "compaction_update",
    compactionId: "c",
    status: "in_progress",
  });
  for (const text of ["**Retained", " summary**"])
    applyUpdate(s, {
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c",
      content: { type: "text", text },
    });
  applyUpdate(s, {
    sessionUpdate: "compaction_update",
    compactionId: "c",
    status: "completed",
  });
  expect(render(s)).toContain("<strong>Retained summary</strong>");
});
