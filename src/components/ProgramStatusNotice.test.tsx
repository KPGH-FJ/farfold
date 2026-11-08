import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { KeyboardEvent } from "react";
import { ProgramStatusNotice, ProgramStatusView } from "./ProgramStatusNotice";

const status = {
  type: "progress" as const,
  message: "整理完成后会继续原任务",
  truncated: false,
  receivedAtMs: Date.UTC(2026, 10, 8, 1, 2, 3),
};

it("shows a received program hint without inferring a work or permission result", () => {
  const html = renderToStaticMarkup(<ProgramStatusView status={status} />);
  expect(html).toContain("程序提示");
  expect(html).toContain("收到时间");
  expect(html).toMatch(/datetime="2026-11-08T01:02:03\.000Z"/i);
  expect(html).not.toContain("<details open");
  expect(html).not.toContain("已完成");
  expect(html).not.toContain("已停止");
  expect(html).not.toContain("权限已生效");
  expect(html).not.toContain("<button");
});

it("keeps program content as literal text and reports a clipped message", () => {
  const html = renderToStaticMarkup(
    <ProgramStatusView
      status={{
        ...status,
        message:
          '<img src="x" onerror="bad()"> [link](https://example.invalid)',
        truncated: true,
      }}
    />,
  );
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
  expect(html).toContain("部分内容未展示");
});

it("keeps the compact preview on a Unicode boundary and the full text in details", () => {
  const message = "🙂".repeat(121) + "尾部";
  const html = renderToStaticMarkup(
    <ProgramStatusView status={{ ...status, message }} />,
  );
  expect(html).toContain("🙂".repeat(120) + "…");
  expect(html).toContain(message);
  expect(html).not.toContain("�");
});

it("does not present a status for an absent or inactive conversation", () => {
  expect(
    renderToStaticMarkup(<ProgramStatusNotice thread={null} active />),
  ).toBe("");
  expect(
    renderToStaticMarkup(<ProgramStatusNotice thread={null} active={false} />),
  ).toBe("");
});

it.each(["Enter", " ", "Backspace"])(
  "keeps %s in the native disclosure without invoking conversation actions",
  (key) => {
    const card = ProgramStatusView({ status });
    const stopPropagation = vi.fn();
    card.props.children.props.onKeyDown({
      key,
      stopPropagation,
    } as unknown as KeyboardEvent<HTMLElement>);
    expect(stopPropagation).toHaveBeenCalledOnce();
  },
);
