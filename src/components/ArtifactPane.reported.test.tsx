import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { invoke } from "@tauri-apps/api/core";
import { applyUpdate, applyTurnEnd, threads } from "../runtime/sessions";
import { ArtifactPane } from "./ArtifactPane";
import { ThreadPage } from "./ThreadPage";
import { useAgents } from "../runtime/agents";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { ThreadView } from "./ThreadView";
import { ToolStep } from "./thread-items";
import { STRINGS } from "../runtime/strings";
type Element = ReactElement<Record<string, unknown>>;
let serial = 0;
function reported(source: "link" | "location") {
  const s = threads.markOpenFailed(
    `p19:${++serial}`,
    "a",
    "/work",
    `native${serial}`,
    "fixture",
  );
  s.openError = null;
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: `tool${serial}`,
    title: "file",
    kind: "edit",
    status: "completed",
    content:
      source === "link"
        ? [
            {
              type: "content",
              content: {
                type: "resource_link",
                uri: "file:///work/report.pdf",
                name: "report.pdf",
              },
            },
          ]
        : [],
    locations: source === "location" ? [{ path: "/work/report.pdf" }] : [],
  });
  applyTurnEnd(s, { stopReason: "end_turn" });
  return s;
}
function capture(render: () => ReactNode) {
  let tree: ReactNode;
  function Capture() {
    tree = render();
    return tree;
  }
  renderToStaticMarkup(<Capture />);
  const all: Element[] = [];
  const visit = (n: ReactNode) =>
    Children.forEach(n, (c) => {
      if (isValidElement<Record<string, unknown>>(c)) {
        all.push(c);
        visit(c.props.children as ReactNode);
        visit(c.props.header as ReactNode);
      }
    });
  visit(tree);
  return all;
}
afterEach(() => vi.mocked(invoke).mockClear());
it.each(["link", "location"] as const)(
  "completed %s alone exposes tool and round artifact entries without file reads",
  (source) => {
    const s = reported(source);
    const tree = capture(() =>
      ThreadView({
        thread: s,
        active: true,
        agents: [],
        onGoSettings: () => {},
        onOpened: () => {},
      }),
    );
    const tool = tree.find((n) => n.type === ToolStep)!;
    expect(tool.props.onOpenArtifacts).toBeTypeOf("function");
    const settled = tree.find((n) => n.props.item === s.items.at(-1))!;
    expect(settled.props.artifactCount).toBe(1);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) =>
            command.startsWith("file_") ||
            command.startsWith("browser_") ||
            command.startsWith("settings_"),
        ),
    ).toEqual([]);
  },
);
it.each(["link", "location"] as const)(
  "%s reported file appears in all, step and round lists without automatic inspect",
  (source) => {
    const s = reported(source),
      tool = s.items.find((n) => n.kind === "tool")!,
      round = s.items.at(-1)!;
    for (const id of [undefined, tool.id, round.id]) {
      threads.openArtifactPane(s.key, id);
      const html = renderToStaticMarkup(<ArtifactPane thread={s} active />);
      expect(html).toContain("/work/report.pdf");
      expect(html).not.toContain(STRINGS.artifacts.empty);
    }
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) =>
            command.startsWith("file_") ||
            command.startsWith("browser_") ||
            command.startsWith("settings_"),
        ),
    ).toEqual([]);
  },
);

it("the all-content header counts a completed link without probing the file", () => {
  const s = reported("link");
  const tree = capture(() =>
    ThreadPage({
      viewKey: s.key,
      active: true,
      agents: useAgents(),
      onGoSettings: () => {},
      onOpened: () => {},
      onBack: () => {},
      onNew: () => {},
      navToggle: null,
    }),
  );
  const header = tree.find((n) => n.props["aria-label"] === W.showContent)!;
  expect(header).toBeDefined();
  expect(
    Children.toArray(header.props.children as ReactNode)
      .filter(isValidElement<Record<string, unknown>>)
      .find((n) => n.type === "small")?.props.children,
  ).toBe(1);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) =>
          command.startsWith("file_") ||
          command.startsWith("browser_") ||
          command.startsWith("settings_"),
      ),
  ).toEqual([]);
});
