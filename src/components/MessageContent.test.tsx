import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAttachments, MessageContent } from "./MessageContent";

it("preserves Markdown after remount and renders new text for the same streaming message", () => {
  const source = {};
  const render = (text: string) =>
    renderToStaticMarkup(<MessageContent source={source} text={text} />);
  const first = render("**First** [link](https://example.com)");
  expect(first).toContain("<strong>First</strong>");
  expect(render("**First** [link](https://example.com)")).toBe(first);
  const updated = render("**Second** [unsafe](javascript:alert)");
  expect(updated).toContain("<strong>Second</strong>");
  expect(updated).not.toContain("First");
  expect(updated).not.toContain("javascript:");
});

it("renders actual image, audio, file and text-resource messages without raw or executable markup", () => {
  const html = renderToStaticMarkup(
    <MessageContent
      source={{}}
      text=""
      attachments={[
        {
          name: "图片",
          kind: "image",
          data: "aW1hZ2U=",
          mimeType: "image/png",
        },
        {
          name: "音频",
          kind: "audio",
          data: "YXVkaW8=",
          mimeType: "audio/wav",
        },
        {
          name: "notes.md",
          kind: "resource",
          uri: "file:///notes.md",
          text: "<script>not executable</script>",
        },
        {
          name: "external",
          kind: "resource_link",
          uri: "https://example.com/file",
        },
        {
          name: "unsupported",
          kind: "resource",
          uri: "javascript:alert(1)",
          data: "eA==",
          mimeType: "text/html",
        },
      ]}
    />,
  );
  expect(html).toContain("<img");
  expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
  expect(html).toContain('<audio controls="" preload="none"');
  expect(html).toContain("notes.md");
  expect(html).toContain("&lt;script&gt;not executable&lt;/script&gt;");
  expect(html).toContain('href="https://example.com/file"');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("data:text/html");
  expect(html).toContain("此附件暂不支持预览");
});

it("starts structured attachments as compact file items while retaining the original details for explicit expansion", () => {
  const attachments = [
    {
      name: "notes.md",
      kind: "resource" as const,
      uri: "file:///a/long/project/path/notes.md",
      mimeType: "text/markdown",
      text: "Original attachment content\n<script>not executable</script>",
    },
    {
      name: "report.pdf",
      kind: "resource_link" as const,
      uri: "https://example.com/report.pdf",
    },
  ];
  const before = JSON.stringify(attachments);
  const html = renderToStaticMarkup(
    <MessageAttachments attachments={attachments} />,
  );
  expect(html.match(/<details\b/g)).toHaveLength(2);
  expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  const summaries = [
    ...html.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g),
  ];
  expect(summaries).toHaveLength(2);
  expect(summaries[0][1]).toContain("notes.md");
  expect(summaries[1][1]).toContain("report.pdf");
  expect(summaries[0][1]).not.toContain("file://");
  expect(summaries[0][1]).not.toContain("Original attachment content");
  expect(summaries[0][1]).not.toContain("text/markdown");
  expect(summaries[1][1]).not.toContain("<a ");
  expect(html).toContain(attachments[0].uri);
  expect(html).toContain("Original attachment content");
  expect(html).toContain("&lt;script&gt;not executable&lt;/script&gt;");
  expect(html).toContain('href="https://example.com/report.pdf"');
  expect(JSON.stringify(attachments)).toBe(before);
});

it("keeps attachment keyboard actions from triggering conversation approval without preventing expansion or media controls", () => {
  const element = MessageAttachments({
    attachments: [
      { name: "notes.md", kind: "resource_link", uri: "file:///notes.md" },
    ],
  });
  const handler = element?.props.onKeyDown;
  expect(handler).toBeTypeOf("function");
  for (const key of ["Enter", "Backspace", "Escape", "Tab", " "]) {
    let stopped = false;
    let prevented = false;
    handler({
      key,
      stopPropagation: () => {
        stopped = true;
      },
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(stopped).toBe(key === "Enter" || key === "Backspace");
    expect(prevented).toBe(false);
  }
});

it("does not infer structured attachments from ordinary text resembling a file context", () => {
  const text =
    '[@notes.md](file:///notes.md)\n<context ref="file:///notes.md">\nKeep this ordinary user text\n</context>';
  const html = renderToStaticMarkup(<MessageContent source={{}} text={text} />);
  expect(html).toContain("Keep this ordinary user text");
  expect(html).not.toContain("<details");
  expect(html).not.toContain('class="message-attachments"');
});
