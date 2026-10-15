import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      slot.deps = deps;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../runtime/sessions", () => ({
  threads: { closeArtifactPane: vi.fn(), openArtifactPane: vi.fn() },
}));
import { ArtifactPane } from "./ArtifactPane";
import { FilePreviewPicker } from "./FilePreviewPicker";
import { FileArtifactView } from "./FileArtifactView";
import { applyUpdate } from "../runtime/session_projection";
import { OpenedFileView } from "./OpenedFileView";
import { freshThreadState } from "../runtime/session_projection";
import type { VerifiedFile } from "../runtime/file_delivery";

type Element = ReactElement<Record<string, unknown>>;
const file: VerifiedFile = {
  root: "/chosen",
  path: "/chosen/report.pptx",
  resolvedPath: "/chosen/report.pptx",
  name: "report.pptx",
  size: 28880,
  sha256: "a".repeat(64),
  version: "v1",
};
let props: Parameters<typeof ArtifactPane>[0];
function nodes(tree: ReactNode): Element[] {
  const all: Element[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, unknown>>(node))
      all.push(node, ...nodes(node.props.children as ReactNode));
  });
  return all;
}
function render() {
  for (let i = 0; i < 6; i++) {
    h.cursor = 0;
    const tree = nodes(ArtifactPane(props));
    if (!h.effects.length) return tree;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw Error("Unexpected effect loop");
}
const picker = () => render().find((node) => node.type === FilePreviewPicker)!;
const opened = () => render().find((node) => node.type === OpenedFileView);
function publish(node = picker()) {
  (node.props.onOpenFile as (file: VerifiedFile) => void)(file);
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  props = {
    thread: freshThreadState("one", "agent", "/work", "native"),
    active: true,
    open: true,
  };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.unstubAllGlobals();
});

it("passes an explicit visible-input destination to both selected disk files and artifact feedback", () => {
  const destination = {
    threadKey: props.thread.key,
    draftKey: "new",
    isCurrent: () => true,
  };
  props = { ...props, feedbackDestination: destination };
  applyUpdate(props.thread, {
    sessionUpdate: "tool_call",
    toolCallId: "write",
    title: "write",
    kind: "edit",
    status: "completed",
    content: [
      { type: "diff", path: "/work/report.md", oldText: null, newText: "text" },
    ],
  });
  const old = render().find((node) => node.type === FileArtifactView)!.props
    .feedbackDestination as typeof destination;
  expect(old.threadKey).toBe(destination.threadKey);
  expect(old.draftKey).toBe("new");
  expect(old.isCurrent()).toBe(true);
  publish();
  const selected = opened()!.props.feedbackDestination as typeof destination;
  expect(old.isCurrent()).toBe(false);
  expect(selected.isCurrent()).toBe(true);
  (opened()!.props.onBack as () => void)();
  expect(selected.isCurrent()).toBe(false);
});
