import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const hooks = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.states.length) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (next: unknown) => {
        hooks.states[index] =
          typeof next === "function" ? next(hooks.states[index]) : next;
      },
    ];
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));
vi.mock("../runtime/sessions", () => ({
  threads: { closeArtifactPane: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { ArtifactPane } from "./ArtifactPane";
import { BrowserWorkspace } from "./BrowserWorkspace";
import { FileArtifactView } from "./FileArtifactView";
import { browserSurfaceGuard as guard } from "../runtime/browser_surface";
import { BROWSER_WORKSPACE_STRINGS as S } from "../runtime/browser_workspace_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { freshThreadState } from "../runtime/session_projection";
import { threads } from "../runtime/sessions";

type Element = ReactElement<Record<string, any>>;
function elements(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, any>>(child)) return;
    result.push(child, ...elements(child.props.children));
  });
  return result;
}
const thread = freshThreadState(
  "empty-browser-task",
  "fixture-agent",
  "/fixture",
  "fixture-native",
);
function render(active = true, open = true) {
  hooks.cursor = 0;
  return elements(ArtifactPane({ thread, active, open }));
}
beforeEach(() => {
  hooks.states = [];
  vi.mocked(threads.closeArtifactPane).mockClear();
});
afterEach(() => guard.requestClose());

it("offers webpage access without any file or output artifacts and keeps it unshared", () => {
  expect(thread.items).toEqual([]);
  const tab = render().find(
    (node) => node.type === "button" && node.props.children === S.title,
  )!;
  expect(tab).toBeDefined();
  tab.props.onClick();
  const browser = render().find((node) => node.type === BrowserWorkspace)!;
  expect(browser.props.taskKey).toBe(thread.key);
  expect(browser.props.active).toBe(true);
  expect(browser.props).not.toHaveProperty("onShare");
  expect(
    render(false).find((node) => node.type === BrowserWorkspace)?.props.active,
  ).toBe(false);
});

it("keeps the content footprint until native hide acknowledges without closing the page", () => {
  render()
    .find((node) => node.type === "button" && node.props.children === S.title)!
    .props.onClick();
  const browser = render().find((node) => node.type === BrowserWorkspace)!;
  browser.props.onVisibilityChange(true);
  const closeNative = vi.fn(async () => {});
  const unregister = guard.register(closeNative);
  render()
    .find((node) => node.props["aria-label"] === W.hideContent)!
    .props.onClick();
  expect(threads.closeArtifactPane).toHaveBeenCalledWith(thread.key);
  let collapsed = render(true, false);
  expect(collapsed.find((node) => node.type === "aside")!.props.hidden).toBe(
    false,
  );
  const held = collapsed.find((node) => node.type === BrowserWorkspace)!;
  expect(held.props.visible).toBe(false);
  expect(held.props.active).toBe(true);
  expect(closeNative).not.toHaveBeenCalled();
  held.props.onVisibilityChange(false);
  collapsed = render(true, false);
  expect(collapsed.find((node) => node.type === "aside")!.props.hidden).toBe(
    true,
  );
  expect(
    collapsed.find((node) => node.type === BrowserWorkspace),
  ).toBeDefined();
  unregister();
});

it("routes verified HTML from the file view through the same browser pane owner", () => {
  const fixture = freshThreadState(
    "file-task",
    "fixture-agent",
    "/fixture",
    "fixture-native",
  );
  fixture.items.push({
    kind: "tool",
    id: "tool-html",
    call: {
      toolCallId: "html",
      title: "write",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "game.html",
          oldText: null,
          newText: "REPORTED FRAGMENT",
        },
      ],
      locations: [],
      startedAt: 1,
      endedAt: 2,
    },
  });
  const renderFile = (active = true, open = true) => {
    hooks.cursor = 0;
    return elements(ArtifactPane({ thread: fixture, active, open }));
  };
  const file = renderFile().find((node) => node.type === FileArtifactView)!;
  const verified = {
    root: "/fixture",
    path: "game.html",
    resolvedPath: "/fixture/game.html",
    name: "game.html",
    size: 200,
    sha256: "fixture",
    version: "v1",
  };
  file.props.onOpenHtml(verified);
  const browser = renderFile().find((node) => node.type === BrowserWorkspace)!;
  expect(browser.props.visible).toBe(true);
  expect(browser.props.htmlRequest).toEqual({
    taskKey: fixture.key,
    file: verified,
  });
  expect(browser.props.htmlRequest.file).not.toHaveProperty("newText");
  browser.props.onHtmlRequestConsumed();
  expect(
    renderFile().find((node) => node.type === BrowserWorkspace)!.props
      .htmlRequest,
  ).toBeNull();
});
