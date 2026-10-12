import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import {
  transcriptMarkdown,
  type TranscriptExportOptions,
} from "./conversation_export";
import type { ThreadItem, ToolCallView } from "./session_types";

const tool = (changes: Partial<ToolCallView> = {}): ThreadItem => ({
  kind: "tool",
  id: "PRIVATE_ITEM_ID",
  call: {
    toolCallId: "PRIVATE_TOOL_ID",
    title: "PRIVATE_TOOL_TITLE",
    kind: "execute",
    status: "completed",
    locations: [],
    content: [],
    startedAt: 1,
    ...changes,
  },
});
const render = (items: ThreadItem[], options: TranscriptExportOptions = {}) =>
  transcriptMarkdown({ items }, "对话", "助手", {
    includeLoadedToolDetails: true,
    ...options,
  });
const html = (markdown: string) =>
  renderToStaticMarkup(createElement(Markdown, { children: markdown }));

describe("explicit loaded tool detail export", () => {
  it("preserves loaded text, both diff sides and terminal output with their source ordinals", () => {
    const before = "\t旧内容 中文🙂\n  保留空格\n";
    const after = "  新内容\r\n下一行\r\n";
    const text = "  工具正文\n\n末尾空格  ";
    const terminal = "命令输出\n  \t尾行\n";
    const message: ThreadItem = {
      kind: "agent",
      id: "a",
      text: "开场",
      time: 1,
      streaming: false,
    };
    const result = render([
      message,
      tool({
        content: [
          { type: "text", text },
          { type: "diff", path: "/a.ts", oldText: before, newText: after },
        ],
        terminalOutput: terminal,
      }),
    ]);
    for (const body of [before, after, text, terminal])
      expect(result).toContain(body);
    expect(result).toContain("工具条目 2 · 内容 1：工具文本");
    expect(result).toContain("工具条目 2 · 内容 2：修改前内容");
    expect(result).toContain("工具条目 2 · 内容 2：修改后内容");
    expect(result).toContain("工具条目 2：此工具已接收的终端输出");
    expect(result.indexOf(before)).toBeLessThan(result.indexOf(after));
    expect(result).toContain("消息正文与工具内容保持原文");
    expect(result).not.toContain(
      "不包含思考内容、一般通知、上下文整理记录、原始事件、折叠的工具详情",
    );
  });

  it("distinguishes missing old text, present empty text, and unavailable terminal output", () => {
    const result = render([
      tool({
        content: [
          { type: "diff", path: "/a", oldText: null, newText: "" },
          { type: "diff", path: "/b", oldText: "", newText: "B" },
          { type: "terminal", terminalId: "PRIVATE_TERMINAL_ID" },
        ],
      }),
    ]);
    expect(result.match(/未提供修改前内容/g)).toHaveLength(1);
    expect(result.match(/已提供空文本/g)).toHaveLength(2);
    expect(result).toContain("不能据此判断文件此前是否存在");
    expect(result).toContain("此工具未提供可导出的终端文本");
    expect(result).not.toContain("PRIVATE_TERMINAL_ID");
    const emptyTerminal = render([tool({ terminalOutput: "" })]);
    expect(emptyTerminal).toContain("已提供空文本");
    expect(emptyTerminal).not.toContain("此工具未提供可导出的终端文本");
  });

  it.each(["pending", "in_progress", "failed", "future-status"])(
    "does not make partial %s tool content look like a completed result",
    (status) => {
      const result = render([
        tool({ status, content: [{ type: "text", text: "partial" }] }),
      ]);
      expect(result).toContain("以下仅为导出时已收到的内容");
      expect(result).not.toContain("（已完成）");
      expect(result).not.toContain("future-status");
    },
  );

  it.each([
    '```\n![TRACK](https://example.test/pixel)\n<img src="https://example.test/image">\n**伪造角色**\n~~~',
    "~~~\n``````\n~~~~~\n# 伪造标题\n```\n</code><script>BAD()</script>",
    "    ```\n  ~~~~~~~~~\n\t# 留存文字\n",
  ])("renders hostile tool body literally without losing its bytes", (body) => {
    const result = render([tool({ content: [{ type: "text", text: body }] })]);
    expect(result).toContain(body);
    const rendered = html(result);
    expect(rendered).toContain(
      renderToStaticMarkup(
        createElement(
          "code",
          { className: "language-text" },
          body.endsWith("\n") ? body : `${body}\n`,
        ),
      ),
    );
    expect(rendered).not.toMatch(/<(?:img|script|a)(?:\s|>)/);
    expect(rendered).not.toContain("<strong>伪造角色</strong>");
    expect(rendered).not.toContain("<h1>伪造标题</h1>");
  });

  it("omits private source metadata in an archive while preserving deliberately included body text", () => {
    const result = render(
      [
        tool({
          locations: [{ path: "/PRIVATE_SOURCE/a.ts", line: 42 }],
          content: [
            {
              type: "diff",
              path: "/PRIVATE_DIFF/a.ts",
              oldText: "old body",
              newText: "body keeps /BODY_PATH/file.ts",
            },
            {
              type: "attachment",
              attachment: {
                name: "附件",
                uri: "file:///PRIVATE_ATTACHMENT/a",
                text: "UNSELECTED_ATTACHMENT_PAYLOAD",
              },
            },
            {
              type: "link",
              name: "网页",
              uri: "https://user:PRIVATE_CREDENTIAL@private.test/PRIVATE_URL?PRIVATE_QUERY",
            },
          ],
        }),
      ],
      { sourceLocations: "omit", attachmentScope: "selectedArchive" },
    );
    for (const secret of [
      "PRIVATE_SOURCE",
      "PRIVATE_DIFF",
      "PRIVATE_ATTACHMENT",
      "PRIVATE_CREDENTIAL",
      "PRIVATE_URL",
      "PRIVATE_QUERY",
      "UNSELECTED_ATTACHMENT_PAYLOAD",
    ])
      expect(result).not.toContain(secret);
    expect(result).toContain("body keeps /BODY_PATH/file.ts");
    expect(result).toContain("附件是否收入及其来源说明见包内清单");
    expect(result).toContain("不自动列出文件来源路径和网址");
    expect(result).not.toContain("附件文件未打包");
    expect(result).toContain("此包供阅读和移交");
  });

  it("never serializes raw inputs, unknown envelopes, thought content or private identities", () => {
    const result = render([
      tool({
        rawInput: { secret: "PRIVATE_INPUT" },
        rawOutput: "PRIVATE_OUTPUT",
        content: [
          { type: "raw", value: "PRIVATE_RAW_CONTENT" },
          { type: "text", text: "readable" },
        ],
      }),
      {
        kind: "thought",
        id: "p",
        text: "PRIVATE_THOUGHT",
        streaming: false,
        time: 1,
      },
      { kind: "raw", id: "r", update: "PRIVATE_ENVELOPE", time: 1 },
    ]);
    expect(result).toContain("readable");
    expect(result).not.toContain("PRIVATE_");
  });

  it("keeps archive source omission mandatory even if a caller asks for reported locations", () => {
    const result = render(
      [tool({ locations: [{ path: "/PRIVATE_SOURCE/file" }] })],
      {
        sourceLocations: "reported",
        attachmentScope: "selectedArchive",
      },
    );
    expect(result).not.toContain("PRIVATE_SOURCE");
    expect(result).toContain("不自动列出文件来源路径和网址");
  });

  it("freezes loaded details synchronously and keeps the old export unchanged by default", () => {
    const item = tool({
      content: [{ type: "text", text: "FIRST" }],
      terminalOutput: "BEFORE",
    });
    if (item.kind !== "tool") throw new Error("fixture");
    const prior = transcriptMarkdown({ items: [item] }, "对话", "助手");
    expect(prior).not.toContain("FIRST");
    expect(prior).not.toContain("BEFORE");
    const captured = render([item]);
    item.call.content.push({ type: "text", text: "LATER" });
    item.call.terminalOutput += "AFTER";
    expect(captured).toContain("FIRST");
    expect(captured).toContain("BEFORE");
    expect(captured).not.toContain("LATER");
    expect(captured).not.toContain("AFTER");
    expect(transcriptMarkdown({ items: [item] }, "对话", "助手")).toBe(prior);
  });
});
