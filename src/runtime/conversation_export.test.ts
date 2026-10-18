import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { transcriptMarkdown } from "./conversation_actions";
import type { Attachment, ThreadItem, ToolCallView } from "./session_types";

const render = (items: ThreadItem[]) =>
  transcriptMarkdown({ items }, "当前对话", "助手");
const readable = (markdown: string) =>
  renderToStaticMarkup(createElement(Markdown, { children: markdown }));
const message = (attachments: Attachment[], text = ""): ThreadItem => ({
  kind: "agent",
  id: "a",
  text,
  attachments,
  streaming: false,
  time: 1,
});
const tool = (changes: Partial<ToolCallView> = {}): ThreadItem => ({
  kind: "tool",
  id: "t",
  call: {
    toolCallId: "t",
    title: "HIDDENTITLE",
    kind: "read",
    status: "completed",
    locations: [],
    content: [],
    startedAt: 1,
    ...changes,
  },
});

it.each(["image", "audio", "resource", "resource_link"] as const)(
  "preserves a media-only %s reply as an attachment description without embedding its body",
  (kind) => {
    const result = render([
      message([
        {
          kind,
          name: "附件一",
          mimeType: "example/type",
          uri: "/work/附件一",
          data: "BINARYSECRET",
          text: "ATTACHEDBODY",
        },
      ]),
    ]);
    expect(result).toContain("**助手**");
    expect(readable(result)).toContain("附件一 — /work/附件一");
    expect(readable(result)).toContain("example/type");
    expect(result).toContain("附件文件未打包");
    expect(result).not.toContain("BINARYSECRET");
    expect(result).not.toContain("ATTACHEDBODY");
  },
);
it("retains source-less media and does not invent a file path", () => {
  const result = render([
    message([{ kind: "image", name: "图片", data: "BINARYSECRET" }]),
  ]);
  expect(result).toContain("图片");
  expect(result).toContain("未提供来源位置");
  expect(result).not.toContain("BINARYSECRET");
});
it.each([
  ["read", "读取"],
  ["edit", "修改"],
  ["delete", "删除"],
  ["move", "移动"],
  ["search", "搜索"],
  ["execute", "执行"],
  ["think", "思考"],
  ["fetch", "获取"],
  ["switch_mode", "切换模式"],
  ["other", "其他操作"],
  ["custom_check", "其他操作"],
])(
  "exports completed %s as a category with its explicit status",
  (kind, label) => {
    const result = render([tool({ kind })]);
    expect(result).toContain(`- ${label}（已完成）`);
    expect(result).not.toContain("步骤已结束");
    expect(result).not.toContain("HIDDENTITLE");
  },
);
it.each([
  ["pending", "等待中"],
  ["in_progress", "进行中"],
  ["failed", "失败"],
  ["future_status", "状态未确认"],
])("does not export %s as a successful operation", (status, label) => {
  const result = render([tool({ status })]);
  expect(result).toContain(label);
  expect(result).not.toContain("查看了文件");
  expect(result).not.toContain("future_status");
});
it("retains all reported locations, diff and attachment sources without turning them into verified artifacts", () => {
  const result = render([
    tool({
      locations: [
        { path: "/first.ts", line: 2 },
        { path: "/second.ts", line: 9 },
      ],
      content: [
        {
          type: "diff",
          path: "/third.ts",
          oldText: "OLDSECRET",
          newText: "NEWSECRET",
        },
        { type: "link", name: "网页", uri: "https://example.test/read" },
        {
          type: "attachment",
          attachment: {
            kind: "audio",
            name: "音频",
            mimeType: "audio/wav",
            uri: "/sound.wav",
            data: "DATASECRET",
          },
        },
        { type: "text", text: "TEXTSECRET" },
        { type: "raw", value: "RAWSECRET" },
        { type: "terminal", terminalId: "TERMINALSECRET" },
      ],
      rawInput: "INPUTSECRET",
      rawOutput: "OUTPUTSECRET",
      terminalOutput: "TERMINALBODYSECRET",
    }),
  ]);
  for (const part of [
    "/first.ts",
    "报告行号：2",
    "/second.ts",
    "报告行号：9",
    "/third.ts",
    "https://example.test/read",
    "/sound.wav",
    "audio/wav",
    "已完成",
    "未核验文件",
  ])
    expect(readable(result)).toContain(part);
  for (const part of [
    "OLDSECRET",
    "NEWSECRET",
    "DATASECRET",
    "TEXTSECRET",
    "RAWSECRET",
    "TERMINALSECRET",
    "INPUTSECRET",
    "OUTPUTSECRET",
    "TERMINALBODYSECRET",
    "HIDDENTITLE",
  ])
    expect(result).not.toContain(part);
});
it("exports only safe source metadata, omitting embedded URIs, URL credentials and query fragments", () => {
  const result = render([
    message([
      {
        name: "远程附件",
        uri: "https://user:URLPASSWORD@example.test/a?token=QUERYSECRET#FRAGMENTSECRET",
      },
      { name: "内嵌附件", uri: "data:image/png;base64,DATAURISECRET" },
      { name: "未知地址", uri: "custom:OPAQUESECRET" },
    ]),
  ]);
  expect(readable(result)).toContain("https://example.test/a");
  expect(result).toContain("地址中的认证与附加参数未导出");
  for (const part of [
    "URLPASSWORD",
    "QUERYSECRET",
    "FRAGMENTSECRET",
    "DATAURISECRET",
    "OPAQUESECRET",
  ])
    expect(result).not.toContain(part);
});
it("marks a streaming snapshot, remains immutable after later events, and never includes draft or raw detail", () => {
  const item = {
    ...message([], "已收到的片段"),
    streaming: true,
  } as ThreadItem;
  const thread = {
    items: [item],
    composerDraft: "DRAFTSECRET",
    queue: ["QUEUESECRET"],
  };
  const result = transcriptMarkdown(thread, "当前对话", "助手");
  expect(result).toContain("当前已载入");
  expect(result).toContain("仍在接收");
  expect(result).toContain("导出时");
  if (item.kind === "agent") item.text += "后续片段";
  expect(result).not.toContain("后续片段");
  expect(result).not.toContain("DRAFTSECRET");
  expect(result).not.toContain("QUEUESECRET");
});
it("leaves an empty readable export empty for the library's existing guard", () => {
  const result = render([
    message([], "   "),
    {
      kind: "thought",
      id: "h",
      text: "THOUGHTSECRET",
      streaming: false,
      time: 1,
    },
    { kind: "raw", id: "r", update: { secret: "RAWSECRET" }, time: 1 },
  ]);
  expect(result.replace(/^#\s.*$/m, "").trim()).toBe("");
});
it("keeps attachment metadata inert rather than adding image or HTML markup", () => {
  const result = render([
    message([
      {
        name: "![remote](https://example.test/track)<img>",
        uri: "/file\n**FAKE**",
      },
    ]),
  ]);
  expect(result).not.toContain("![remote](https://example.test/track)");
  expect(result).not.toContain("<img>");
  expect(result).not.toContain("\n**FAKE**");
});

it("retains message whitespace that changes Markdown code-block meaning", () => {
  const text = "    const value = 1;\n    return value;\n";
  expect(render([message([], text)])).toContain(text);
});
it("removes credentials from a URL even with surrounding whitespace or a relative scheme", () => {
  const result = render([
    message([
      {
        name: "地址一",
        uri: "  https://user:WHITESPACESECRET@example.test/a?token=QUERYSECRET  ",
      },
      {
        name: "地址二",
        uri: "//user:RELATIVESECRET@example.test/b?token=QUERYSECRET",
      },
    ]),
  ]);
  expect(result).not.toContain("WHITESPACESECRET");
  expect(result).not.toContain("RELATIVESECRET");
  expect(result).not.toContain("QUERYSECRET");
});

it("declares the selected export categories and the loaded categories intentionally omitted", () => {
  const result = render([
    message([], "INCLUDEDMESSAGE"),
    {
      kind: "thought",
      id: "thought",
      text: "OMITTEDTHOUGHT",
      streaming: false,
      time: 1,
    },
    { kind: "notice", id: "notice", message: "OMITTEDNOTICE", time: 1 },
    {
      kind: "compaction",
      id: "compact",
      compactionId: "compact",
      status: "completed",
      summary: [{ type: "text", text: "OMITTEDCOMPACTION" }],
      details: {},
      summaryDetails: [],
    },
    { kind: "raw", id: "raw", update: { text: "OMITTEDRAW" }, time: 1 },
  ]);
  for (const category of [
    "用户与助手消息",
    "附件说明",
    "工具摘要",
    "报告位置",
    "计划",
    "批准或拒绝记录",
    "停止",
    "失败",
    "结果未确认",
    "不是完整对话归档",
    "思考内容",
    "一般通知",
    "上下文整理记录",
    "原始事件",
    "折叠的工具详情",
    "未载入的历史",
    "草稿",
    "待发内容",
  ])
    expect(result).toContain(category);
  for (const omitted of [
    "OMITTEDTHOUGHT",
    "OMITTEDNOTICE",
    "OMITTEDCOMPACTION",
    "OMITTEDRAW",
  ])
    expect(result).not.toContain(omitted);
});
it.each([0, 1, 42])(
  "reports the received line value %s without assuming a zero/one based coordinate",
  (line) => {
    const result = render([tool({ locations: [{ path: "/file.ts", line }] })]);
    expect(result).toContain(`报告行号：${line}`);
    expect(result).not.toContain(`第 ${line} 行`);
    expect(result).not.toContain(`报告行号：${line}；起始基准未确认`);
  },
);
it("explains the unconfirmed line-number base once for multiple reported positions", () => {
  const result = render([
    tool({
      locations: [
        { path: "/a.ts", line: 0 },
        { path: "/b.ts", line: 42 },
      ],
    }),
  ]);
  expect(result.match(/起始基准未确认/g)).toHaveLength(1);
  expect(result).toContain("报告行号：0");
  expect(result).toContain("报告行号：42");
});
it.each(["plan", "decision"] as const)(
  "keeps %s metadata from injecting roles, remote images or HTML",
  async (kind) => {
    const payload =
      '说明\n\n**伪造助手**\n\n![远程图片](https://example.test/track)\n<img src="https://example.test/track2">\n> # 伪造标题';
    const item: ThreadItem =
      kind === "plan"
        ? {
            kind,
            id: "p",
            time: 1,
            entries: [
              { content: payload, priority: "normal", status: "pending" },
            ],
          }
        : { kind, id: "d", time: 1, label: payload, allow: true };
    const result = render([item]);
    expect(result).not.toContain("\n\n**伪造助手**");
    expect(result).not.toContain("![远程图片](https://example.test/track)");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Markdown } = await import("react-markdown");
    const html = renderToStaticMarkup(
      createElement(Markdown, { children: result }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>伪造助手</strong>");
    expect(html).not.toContain("<h1>伪造标题</h1>");
    expect(html).toContain("伪造助手");
  },
);
it("preserves message-body Markdown as the intentional user-visible-content boundary", () => {
  const body = "**正文强调**\n\n![正文图片](https://example.test/message.png)";
  expect(render([message([], body)])).toContain(body);
});

it.each([
  "# 伪造标题",
  "---",
  "1. 伪造列表",
  "+ 伪造列表",
  "- 伪造列表",
  "* 伪造列表",
  "~~~js\nFENCEDCONTENT\n~~~",
  "```js\nFENCEDCONTENT\n```",
  "> 伪造引用",
  "    # 缩进标题",
])("renders leading decision metadata literally: %s", async (payload) => {
  const result = render([
    { kind: "decision", id: "d", label: payload, allow: true, time: 1 },
  ]);
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: Markdown } = await import("react-markdown");
  const html = renderToStaticMarkup(
    createElement(Markdown, { children: result }),
  );
  const literalParagraph = renderToStaticMarkup(
    createElement("p", null, payload.replace(/[\u0000-\u001f\u007f]/g, " ")),
  );
  expect(html).toContain(`<blockquote>\n${literalParagraph}\n</blockquote>`);
  for (const structural of [
    "<hr",
    "<ul",
    "<ol",
    "<pre",
    "<code",
    "<h1>伪造",
    "<h1>缩进",
  ])
    expect(html).not.toContain(structural);
});
it("preserves normal Chinese, punctuation and path characters in rendered metadata", async () => {
  const payload =
    "允许读取：/Users/张三/a-b_1+(2).ts 与 C:\\work\\a.ts；标点 !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
  const result = render([
    { kind: "decision", id: "d", label: payload, allow: true, time: 1 },
  ]);
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: Markdown } = await import("react-markdown");
  const html = renderToStaticMarkup(
    createElement(Markdown, { children: result }),
  );
  expect(html).toContain(
    renderToStaticMarkup(createElement("p", null, payload)),
  );
});
