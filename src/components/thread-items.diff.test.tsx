import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView, ToolStep } from "./thread-items";
import type { ToolCallView } from "../runtime/session_types";
import { TranscriptSearchContext } from "./transcript-search";
import { FileDifference } from "./FileArtifactView";
import { DIFF_LIMITS } from "../runtime/line_diff";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";

const call: ToolCallView = {
  toolCallId: "diff-fixture",
  title: "Edit",
  kind: "edit",
  status: "completed",
  startedAt: 1,
  endedAt: 2,
  locations: [],
  content: [
    { type: "diff", path: "/work/a.txt", oldText: "a\nb", newText: "a\nc" },
  ],
};

it("counts the changed fragment rows, not every supplied line", () => {
  const html = renderToStaticMarkup(<ToolStep call={call} />);
  expect(html).toContain('class="add">+1</span>');
  expect(html).toContain('class="del">−1</span>');
});

it("keeps missing original text distinct from a newly created file", () => {
  const html = renderToStaticMarkup(
    <DiffView path="/work/a.txt" oldText={null} newText={"a\nb"} />,
  );
  expect(html).toContain("未提供修改前的文本");
  expect(html).not.toContain("新文件");
});

it.each([
  ["a\nb", "a\nc", "所示片段 · 新增 1 行、删除 1 行"],
  ["a\nb", "a\nb", "所示片段 · 正文相同"],
  [null, "a\nb", "缺少修改前文本，无法比较"],
  ["", "a\nb", "所示片段 · 新增 2 行、删除 0 行"],
  ["a\n\nb", "a\nb", "所示片段 · 新增 0 行、删除 1 行"],
] as const)(
  "uses the same truthful conclusion for both views (%s)",
  (oldText, newText, label) => {
    const card = {
      kind: "diff" as const,
      path: "/work/a.txt",
      oldText,
      newText,
      scope: "fragment" as const,
      source: "diff" as const,
      status: "completed",
      time: 0,
    };
    const message = renderToStaticMarkup(<DiffView {...card} />);
    const pane = renderToStaticMarkup(
      <FileDifference card={card} onLine={() => {}} />,
    );
    expect(message).toContain(label);
    expect(pane).toContain(label);
    if (oldText === null) expect(message).not.toContain('class="add"');
  },
);

it("shows ending-only changes in both views and keeps body lines neutral", () => {
  const card = {
    kind: "diff" as const,
    path: "/work/a.txt",
    oldText: "a\r\nb\n",
    newText: "a\nb",
    scope: "fragment" as const,
    source: "diff" as const,
    status: "completed",
    time: 0,
  };
  for (const node of [
    <DiffView {...card} />,
    <FileDifference card={card} onLine={() => {}} />,
  ]) {
    const html = renderToStaticMarkup(node);
    expect(html).toContain("已对齐行的换行变化（2 处）");
    expect(html).toContain("没有行末换行");
    expect(html).toContain("CRLF");
    expect(html).not.toMatch(/class="(?:add|del)"/);
  }
});

it("does not publish a precise aggregate when another report has no comparable before side", () => {
  const html = renderToStaticMarkup(
    <ToolStep
      call={{
        ...call,
        content: [
          ...call.content,
          {
            type: "diff",
            path: "/work/b",
            oldText: null,
            newText: "unknown-old",
          },
        ],
      }}
    />,
  );
  expect(html).toContain(W.diffPartial);
  expect(html).not.toContain('class="add"');
});

it.each(["failed", "in_progress", "unknown", "future-status"])(
  "keeps %s output without saying that it is a disk result",
  (status) => {
    const html = renderToStaticMarkup(
      <DiffView path="/work/a" oldText="old" newText="new" status={status} />,
    );
    expect(html).toContain(
      status === "failed"
        ? W.fileFailed
        : status === "in_progress"
          ? W.filePending
          : W.fileUnknown,
    );
    expect(html).toContain(W.fileReported);
    expect(html).toContain(W.fragmentNote);
    expect(html).toContain("old");
    expect(html).toContain("new");
  },
);

it.each(["failed", "in_progress", "future-status"])(
  "does not state that a %s tool wrote the file",
  (status) => {
    const html = renderToStaticMarkup(<ToolStep call={{ ...call, status }} />);
    expect(html).not.toContain("修改了文件");
    expect(html).toContain("修改");
  },
);

it("presents replacement fallback neutrally in both views with no exact total", () => {
  const oldText = Array.from({ length: 1100 }, (_, i) => `old-${i}`).join("\n");
  const newText = Array.from({ length: 1100 }, (_, i) => `new-${i}`).join("\n");
  const card = {
    kind: "diff" as const,
    path: "/work/a",
    oldText,
    newText,
    scope: "fragment" as const,
    source: "diff" as const,
    status: "completed",
    time: 0,
  };
  for (const node of [
    <DiffView {...card} />,
    <FileDifference card={card} onLine={() => {}} />,
  ]) {
    const html = renderToStaticMarkup(node);
    expect(html).toContain(W.diffPartial);
    expect(html).toContain(W.diffReplacement);
    expect(html).not.toMatch(
      /class="(?:add|del|artifact-code-row add|artifact-code-row remove)"/,
    );
  }
});

it("does not count unavailable comparisons as zero and still materializes both raw tails for search", () => {
  const oldText = "a".repeat(DIFF_LIMITS.characters) + "old-tail-needle";
  const newText = "new-tail-needle";
  const opened = vi.fn();
  const html = renderToStaticMarkup(
    <TranscriptSearchContext.Provider value>
      <DiffView
        path="/work/raw"
        oldText={oldText}
        newText={newText}
        onOpenFile={opened}
      />
    </TranscriptSearchContext.Provider>,
  );
  expect(html).toContain(W.diffPartial);
  expect(html).toContain("old-tail-needle");
  expect(html).toContain("new-tail-needle");
  expect(html).toContain('hidden=""');
  expect(html).not.toContain('class="add"');
  expect(opened).not.toHaveBeenCalled();
});

it("offers a real explicit file button for a diff path even without locations", () => {
  const opened = vi.fn();
  const html = renderToStaticMarkup(
    <TranscriptSearchContext.Provider value>
      <ToolStep call={call} onOpenFile={opened} />
    </TranscriptSearchContext.Provider>,
  );
  expect(html).toContain('title="/work/a.txt"');
  expect(html).toContain("message-file-button");
  expect(opened).not.toHaveBeenCalled();
  expect(html).not.toMatch(/data-find-block[^>]*>所示片段/);
});
