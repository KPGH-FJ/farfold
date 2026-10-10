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
    if (!slot.deps || deps.some((v, i) => !Object.is(v, slot.deps?.[i]))) {
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
import { threads } from "../runtime/sessions";
import { ArtifactPane } from "./ArtifactPane";
import { OpenedFileView } from "./OpenedFileView";
import {
  reportedArtifactFiles,
  type ReportedArtifactFile,
} from "../runtime/reported_artifacts";
import { ReportedFilesList } from "./ReportedFilesList";
import { FileArtifactView } from "./FileArtifactView";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";
type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const all: Element[] = [];
  Children.forEach(tree, (n) => {
    if (isValidElement<Record<string, unknown>>(n))
      all.push(
        n,
        ...nodes(n.props.children as ReactNode),
        ...nodes(n.props.headerSupplement as ReactNode),
      );
  });
  return all;
}
let props: Parameters<typeof ArtifactPane>[0];
function render() {
  for (let i = 0; i < 6; i++) {
    h.cursor = 0;
    const tree = nodes(ArtifactPane(props));
    if (!h.effects.length) return tree;
    for (const run of h.effects.splice(0)) run();
  }
  throw new Error("unexpected effect loop");
}
function opened() {
  return render().find((n) => n.type === OpenedFileView)!;
}

beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const thread = freshThreadState("first", "agent", "/work", "native");
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "edit",
    kind: "edit",
    status: "completed",
    title: "file",
    content: [
      { type: "diff", path: "report.md", oldText: null, newText: "text" },
    ],
  });
  props = { thread, active: true, open: true };
});
afterEach(() => {
  for (const s of h.slots) s.cleanup?.();
  vi.unstubAllGlobals();
});
it.each(["hide", "inactive", "thread", "cwd", "scope", "hide-return"])(
  "old file handler cannot read after %s transition",
  (change) => {
    const old = render().find((n) => n.type === FileArtifactView)!;
    if (change === "hide" || change === "hide-return")
      props = { ...props, open: false };
    if (change === "inactive") props = { ...props, active: false };
    if (change === "thread")
      props = {
        ...props,
        thread: freshThreadState("second", "agent", "/work", "next"),
      };
    if (change === "cwd")
      props = { ...props, thread: { ...props.thread, cwd: "/other" } };
    if (change === "scope")
      props.thread.artifactPaneTarget = {
        roundId: props.thread.items[0].id,
        selected: null,
      };
    render();
    if (change === "hide-return") {
      props = { ...props, open: true };
      render();
    }
    (old.props.onOpenFile as (path: string) => void)("report.md");
    expect(opened()).toBeUndefined();
  },
);

function entry() {
  return reportedArtifactFiles(
    props.thread,
    props.thread.artifactPaneTarget?.roundId ?? null,
  )![0];
}
function list() {
  return render().find((n) => n.type === ReportedFilesList)!;
}
function click(node: Element, value: ReportedArtifactFile) {
  (node.props.onOpenFile as (e: ReportedArtifactFile) => void)(value);
}
it("passive list does not select a first file; one explicit current entry selects the existing reader", () => {
  const node = list(),
    value = entry();
  expect(opened()).toBeUndefined();
  click(node, value);
  const next = opened();
  expect(next.props.path).toBe("report.md");
  expect(next.props.workingDirectory).toBe("/work");
  expect(next.props.active).toBe(true);
});
it("same path new reports do not remount the explicit file or replace its retained reading/opinion owner", () => {
  const node = list(),
    value = entry();
  click(node, value);
  const first = opened();
  applyUpdate(props.thread, {
    sessionUpdate: "tool_call",
    toolCallId: "new-report",
    kind: "edit",
    status: "completed",
    title: "new",
    locations: [{ path: "report.md" }],
    content: [],
  });
  const second = opened();
  expect(second.key).toBe(first.key);
  expect(second.props.readingPosition).toBe(first.props.readingPosition);
  click(node, value);
  expect(opened().key).toBe(first.key);
});
it.each(["hide", "cwd", "scope", "withdraw"])(
  "reported entry refuses retired %s authority",
  (change) => {
    const node = list(),
      value = entry();
    if (change === "hide") props = { ...props, open: false };
    if (change === "cwd")
      props = { ...props, thread: { ...props.thread, cwd: "/other" } };
    if (change === "scope")
      props.thread.artifactPaneTarget = {
        roundId: props.thread.items[0].id,
        selected: null,
      };
    if (change === "withdraw")
      applyUpdate(props.thread, {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit",
        content: [],
      });
    render();
    click(node, value);
    expect(opened()).toBeUndefined();
  },
);
it("source navigation is exact and remains passive", () => {
  const node = list(),
    value = entry(),
    open = vi.fn();
  // The store mock receives only this exact originating item, never a path read.
  const spy = vi.spyOn(threads, "openArtifactPane").mockImplementation(open);
  (
    node.props.onOpenSource as (
      entry: ReportedArtifactFile,
      origin: unknown,
    ) => void
  )(value, value.origins[0]);
  expect(spy).toHaveBeenCalledExactlyOnceWith(
    props.thread.key,
    props.thread.items[0].id,
  );
  expect(opened()).toBeUndefined();
});
