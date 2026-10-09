import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  active: true,
  cursor: 0,
  scope: "",
  slots: new Map<string, unknown[]>(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useContext: () => h.active,
  useRef: (initial: unknown) => {
    const slots = h.slots.get(h.scope)!;
    return (slots[h.cursor++] ??= { current: initial });
  },
  useState: (initial: unknown) => {
    const slots = h.slots.get(h.scope)!;
    const index = h.cursor++;
    slots[index] ??= initial;
    return [
      slots[index],
      (next: unknown) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      },
    ];
  },
}));

import { DiffView, ToolStep } from "./thread-items";
import { revealSearchAncestors } from "../runtime/transcript_search";
import type { ToolCallView } from "../runtime/session_types";
import { STRINGS } from "../runtime/strings";

type Element = ReactElement<Record<string, any>>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (node) => {
    if (!isValidElement<Record<string, any>>(node)) return;
    result.push(node, ...nodes(node.props.children));
  });
  return result;
}
function render<T extends ReactNode>(scope: string, component: () => T): T {
  h.scope = scope;
  h.cursor = 0;
  if (!h.slots.has(scope)) h.slots.set(scope, []);
  return component();
}
// DOM ancestry only: the shared runtime owns each registered model. No copied
// disclosure implementation, fake search index, file API or media loader.
function element(parentElement: HTMLElement | null = null): HTMLElement {
  const self = {
    parentElement,
    contains(node: HTMLElement | null) {
      for (; node; node = node.parentElement) if (node === self) return true;
      return false;
    },
  };
  return self as HTMLElement;
}
const call: ToolCallView = {
  toolCallId: "fold",
  title: "Fixture",
  kind: "edit",
  status: "completed",
  startedAt: 1,
  endedAt: 2,
  locations: [],
  content: [{ type: "text", text: "body" }],
};
beforeEach(() => {
  h.active = true;
  h.slots.clear();
});

it("reveals both the enclosing tool and clipped diff through their real ref registrations, then restores them", () => {
  const root = element();
  const toolElement = element(root);
  const diffElement = element(toolElement);
  const hit = element(diffElement);
  const renderTool = () => render("tool", () => ToolStep({ call }));
  const newText = Array.from({ length: 60 }, (_, i) => `line-${i}`).join("\n");
  const renderDiff = () =>
    render("diff", () => DiffView({ path: "/work/f", oldText: null, newText }));
  let tool = renderTool();
  let diff = renderDiff();
  tool.props.ref(toolElement);
  diff.props.ref(diffElement);
  expect(nodes(tool).some((node) => node.props.hidden === true)).toBe(true);
  expect(nodes(diff).filter((node) => node.props.hidden === true)).toHaveLength(
    36,
  );
  const release = revealSearchAncestors(hit, root);
  tool = renderTool();
  diff = renderDiff();
  expect(
    nodes(tool).find((node) => node.type === "button")?.props["aria-expanded"],
  ).toBe(true);
  expect(nodes(diff).some((node) => node.props.hidden === true)).toBe(false);
  release();
  expect(
    nodes(renderTool()).find((node) => node.type === "button")?.props[
      "aria-expanded"
    ],
  ).toBe(false);
  expect(
    nodes(renderDiff()).filter((node) => node.props.hidden === true),
  ).toHaveLength(36);
  h.active = false;
  expect(
    nodes(renderDiff()).filter(
      (node) => node.props["data-find-block"] === true,
    ),
  ).toHaveLength(25);
});

it("keeps a user's explicit disclosure changes when the search release arrives", () => {
  const root = element();
  const owner = element(root);
  const renderTool = () => render("tool", () => ToolStep({ call }));
  const toggle = () =>
    nodes(renderTool())
      .find((node) => node.props.children === STRINGS.thread.toolDetail)!
      .props.onClick();
  renderTool().props.ref(owner);
  const release = revealSearchAncestors(element(owner), root);
  toggle(); // User explicitly collapses a temporary expansion.
  release();
  expect(
    nodes(renderTool()).find((node) => node.type === "button")?.props[
      "aria-expanded"
    ],
  ).toBe(false);
  toggle(); // User explicitly opens it again.
  const releaseAgain = revealSearchAncestors(element(owner), root);
  releaseAgain();
  h.active = false;
  expect(
    nodes(renderTool()).find((node) => node.type === "button")?.props[
      "aria-expanded"
    ],
  ).toBe(true);
});

it("supports manually expanding and collapsing a long diff when search is closed", () => {
  h.active = false;
  const renderDiff = () =>
    render("diff", () =>
      DiffView({
        path: "/work/f",
        oldText: null,
        newText: Array.from({ length: 50 }, (_, i) => `row-${i}`).join("\n"),
      }),
    );
  const count = () =>
    nodes(renderDiff()).filter((node) => node.props["data-find-block"] === true)
      .length;
  const toggle = () =>
    nodes(renderDiff())
      .find((node) => node.type === "button")!
      .props.onClick();
  expect(count()).toBe(25);
  toggle();
  expect(count()).toBe(51);
  toggle();
  expect(count()).toBe(25);
});
