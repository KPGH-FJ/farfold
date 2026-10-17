import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({ open: false }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [
    h.open,
    (value: boolean | ((current: boolean) => boolean)) => {
      h.open = typeof value === "function" ? value(h.open) : value;
    },
  ],
}));
// The direct-call harness below owns the disclosure value. The actual search
// context and shared expansion model are covered by the dedicated search tests.
vi.mock("./transcript-search", async (original) => ({
  ...(await original<typeof import("./transcript-search")>()),
  useSearchExpansion: () => ({
    open: h.open,
    userOpen: h.open,
    materialized: h.open,
    ref: () => {},
    toggle: () => {
      h.open = !h.open;
    },
  }),
}));
import { ToolStep } from "./thread-items";
import { MessageFileLink } from "./MessageContent";
import type { ToolCallView } from "../runtime/session_types";
import { STRINGS } from "../runtime/strings";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";

const call: ToolCallView = {
  toolCallId: "fixture",
  title: "Create result",
  kind: "edit",
  status: "completed",
  startedAt: 1,
  endedAt: 2,
  locations: [{ path: "/work/a%20b.html", line: 4 }],
  content: [
    { type: "link", name: "Result", uri: "file:///work/game.html" },
    { type: "text", text: "./should-not-open.html" },
  ],
  rawInput: { command: "open /work/game.html", cwd: "/work" },
  rawOutput: "./also-not-a-link.md",
};
function elements(tree: ReactNode): ReactElement<Record<string, any>>[] {
  const result: ReactElement<Record<string, any>>[] = [];
  Children.forEach(tree, (node) => {
    if (!isValidElement<Record<string, any>>(node)) return;
    result.push(node, ...elements(node.props.children));
  });
  return result;
}
beforeEach(() => {
  h.open = false;
});

it("keeps details collapsed and preserves artifact and expand actions while wiring exact location paths", () => {
  const onOpenFile = vi.fn();
  const onOpenArtifacts = vi.fn();
  const props = { call, onOpenFile, onOpenArtifacts };
  let tree = ToolStep(props);
  const location = elements(tree).find(
    (node) => node.type === MessageFileLink,
  )!;
  expect(location.props.path).toBe("/work/a%20b.html");
  expect(location.props.onOpenFile).toBe(onOpenFile);
  expect(renderToStaticMarkup(tree)).not.toContain("step-detail");
  const artifact = elements(tree).find(
    (node) => node.type === "button" && node.props.children === T.viewArtifacts,
  )!;
  const event = {};
  artifact.props.onClick(event);
  expect(onOpenArtifacts).toHaveBeenCalledWith(event);
  elements(tree)
    .find(
      (node) =>
        node.type === "button" &&
        node.props.children === STRINGS.thread.toolDetail,
    )!
    .props.onClick();
  tree = ToolStep(props);
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("step-detail");
  expect(html).toContain('title="/work/game.html"');
  expect(html).toContain('title="/work/a%20b.html"');
  expect(html).not.toContain('title="./should-not-open.html"');
  expect(html).not.toContain('title="./also-not-a-link.md"');
  expect(html).toContain("open /work/game.html");
  expect(onOpenFile).not.toHaveBeenCalled();
});

it("retains inert file locations when no file navigation callback is supplied", () => {
  h.open = true;
  const html = renderToStaticMarkup(<ToolStep call={call} />);
  expect(html).not.toContain("message-file-button");
  expect(html).toContain("/work/game.html");
});

it("renders declared tool media and resources safely without reading files or loading remote images", () => {
  const state = freshThreadState("media", "fixture", "/work", "one");
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "media",
    title: "Media result",
    status: "completed",
    content: [
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
      {
        type: "resource",
        resource: { uri: "file:///notes.md", text: "<script>escaped</script>" },
      },
      {
        type: "resource",
        resource: {
          uri: "memory:///unsafe.svg",
          blob: "eA==",
          mimeType: "image/svg+xml",
        },
      },
      {
        type: "resource_link",
        name: "Remote image",
        uri: "https://example.com/image.png",
      },
    ].map((content) => ({ type: "content", content })),
    rawOutput: { data: "eA==", mimeType: "image/png", text: "Opaque output" },
  });
  const item = state.items[0]!;
  if (item.kind !== "tool") throw new Error("Expected tool output");
  const onOpenFile = vi.fn();
  h.open = true;
  const html = renderToStaticMarkup(
    <ToolStep call={item.call} onOpenFile={onOpenFile} />,
  );
  // Static markup has not mounted or reserved the shared preview budget.
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<audio");
  expect(html.match(/正在准备媒体…/g)).toHaveLength(2);
  expect(html).toContain("&lt;script&gt;escaped&lt;/script&gt;");
  expect(html).toContain("此附件暂不支持预览");
  expect(html).toContain('href="https://example.com/image.png"');
  expect(html).not.toContain('src="https:');
  expect(html).not.toContain("data:image/svg");
  expect(html).not.toContain('src="data:image/png;base64,eA=="');
  expect(html).not.toContain("<script>");
  expect(onOpenFile).not.toHaveBeenCalled();
});
