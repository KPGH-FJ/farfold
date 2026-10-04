import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAttachments, MessageContent } from "./MessageContent";

const capture = vi.hoisted(() => ({
  buttons: [] as Record<string, unknown>[],
}));
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  return {
    ...actual,
    jsx: (...args: Parameters<typeof actual.jsx>) => {
      const props = args[1] as Record<string, unknown> | undefined;
      if (
        args[0] === "button" &&
        props?.className === "message-file-link message-file-button"
      )
        capture.buttons.push(props);
      return actual.jsx(...args);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      const props = args[1] as Record<string, unknown> | undefined;
      if (
        args[0] === "button" &&
        props?.className === "message-file-link message-file-button"
      )
        capture.buttons.push(props);
      return actual.jsxDEV(...args);
    },
  };
});
beforeEach(() => {
  capture.buttons.length = 0;
});

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

function clickCaptured(index = 0) {
  const props = capture.buttons[index];
  expect(props).toBeDefined();
  const opener = { tagName: "BUTTON" } as HTMLElement;
  const stopPropagation = vi.fn();
  (props.onClick as (event: unknown) => void)({
    currentTarget: opener,
    stopPropagation,
    preventDefault: vi.fn(),
  });
  expect(stopPropagation).toHaveBeenCalledOnce();
  return opener;
}

it("opens an exact inline path only after a click, preserving its code appearance", () => {
  const onOpenFile = vi.fn();
  const path = "/Users/tw/Desktop/TR/cat_fishing.html";
  const html = renderToStaticMarkup(
    <MessageContent
      source={{}}
      text={`做好了：\`${path}\``}
      onOpenFile={onOpenFile}
    />,
  );
  expect(html).toContain(`<code>${path}</code>`);
  expect(html).toContain('type="button"');
  expect(onOpenFile).not.toHaveBeenCalled();
  const opener = clickCaptured();
  expect(onOpenFile).toHaveBeenCalledWith(path, opener);
});

it("keeps cached Markdown bound to the latest file callback and permits old messages to become clickable", () => {
  const source = {};
  const text = "[成果](./game.html) 和 `./notes.md`";
  const first = vi.fn();
  const current = vi.fn();
  const render = (onOpenFile?: typeof first) =>
    renderToStaticMarkup(
      <MessageContent source={source} text={text} onOpenFile={onOpenFile} />,
    );
  render();
  expect(capture.buttons).toHaveLength(0);
  render(first);
  expect(capture.buttons).toHaveLength(2);
  capture.buttons.length = 0;
  render(current);
  const opener = clickCaptured();
  expect(current).toHaveBeenCalledWith("./game.html", opener);
  expect(first).not.toHaveBeenCalled();
  capture.buttons.length = 0;
  render();
  expect(capture.buttons).toHaveLength(0);
});

it("never activates paths inside plain or language-labelled code blocks, or shell commands", () => {
  const text = [
    "```",
    "/work/game.html",
    "```",
    "```text",
    "./notes.md",
    "```",
    "`open /work/game.html`",
    "`node ./main.js`",
    "`./run.sh --flag`",
    "ordinary /work/game.html text",
  ].join("\n");
  const onOpenFile = vi.fn();
  const html = renderToStaticMarkup(
    <MessageContent source={{}} text={text} onOpenFile={onOpenFile} />,
  );
  expect(html).toContain("/work/game.html");
  expect(capture.buttons).toHaveLength(0);
  expect(onOpenFile).not.toHaveBeenCalled();
});

it("uses the same callback for structured local resources and ordinary Markdown filenames", () => {
  const onOpenFile = vi.fn();
  renderToStaticMarkup(
    <MessageContent
      source={{}}
      text="[报告](report.pdf)"
      onOpenFile={onOpenFile}
      attachments={[
        { name: "笔记", kind: "resource_link", uri: "file:///work/notes.md" },
      ]}
    />,
  );
  const first = clickCaptured(0);
  const second = clickCaptured(1);
  expect(onOpenFile.mock.calls).toEqual([
    ["report.pdf", first],
    ["/work/notes.md", second],
  ]);
  capture.buttons.length = 0;
  renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        { name: "notes.md", kind: "resource", uri: "file:///work/notes.md" },
      ]}
      onOpenFile={onOpenFile}
    />,
  );
  expect(capture.buttons).toHaveLength(2);
});

it("isolates file-link keyboard actions without suppressing the native button click", () => {
  renderToStaticMarkup(
    <MessageContent source={{}} text="`./game.html`" onOpenFile={vi.fn()} />,
  );
  const handler = capture.buttons[0].onKeyDown as (event: unknown) => void;
  for (const key of ["Enter", " ", "Backspace", "Escape", "Tab"]) {
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    handler({ key, stopPropagation, preventDefault });
    expect(stopPropagation).toHaveBeenCalledTimes(
      ["Enter", " ", "Backspace"].includes(key) ? 1 : 0,
    );
    expect(preventDefault).not.toHaveBeenCalled();
  }
});

it("uses the outer Markdown destination when a link label itself is an inline path", () => {
  const onOpenFile = vi.fn();
  renderToStaticMarkup(
    <MessageContent
      source={{}}
      text="[`./shown.md`](./actual.md) [`/work/name.html`](https://example.com/)"
      onOpenFile={onOpenFile}
    />,
  );
  expect(capture.buttons).toHaveLength(1);
  const opener = clickCaptured();
  expect(onOpenFile).toHaveBeenCalledWith("./actual.md", opener);
});
