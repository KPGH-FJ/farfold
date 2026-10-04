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
import { ToolStep } from "./thread-items";
import { MessageFileLink } from "./MessageContent";
import type { ToolCallView } from "../runtime/session_types";
import { STRINGS } from "../runtime/strings";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";

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
