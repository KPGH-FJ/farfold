import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  dirty: false,
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = next;
        h.dirty = true;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useLayoutEffect: (callback: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++,
      slot = h.slots[index];
    if (!slot || deps.some((value, i) => !Object.is(value, slot.deps?.[i])))
      h.effects.push(() => {
        slot?.cleanup?.();
        h.slots[index].cleanup = callback() || undefined;
      });
    h.slots[index] = { deps, cleanup: slot?.cleanup };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import {
  ReportedFilesList,
  type ReportedFilesListProps,
} from "./ReportedFilesList";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";
import { REPORTED_ARTIFACT_STRINGS as S } from "../runtime/reported_artifact_strings";
import { isReportedArtifactCurrent } from "../runtime/reported_artifacts";

type El = ReactElement<Record<string, unknown>>;
let props: ReportedFilesListProps;
function nodes(tree: ReactNode): El[] {
  const result: El[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child);
    result.push(...nodes(child.props.children as ReactNode));
  });
  return result;
}
function render() {
  let tree: ReactNode;
  for (let i = 0; i < 5; i++) {
    h.cursor = 0;
    h.dirty = false;
    tree = ReportedFilesList(props);
    h.effects.splice(0).forEach((effect) => effect());
    if (!h.dirty) return { nodes: nodes(tree), tree };
  }
  throw new Error("Unsettled fixture");
}
function report(id: string, path = `${id}.md`) {
  applyUpdate(props.thread, {
    sessionUpdate: "tool_call",
    toolCallId: id,
    status: "completed",
    kind: "edit",
    locations: [{ path }],
  });
}
const click = (node: El) => (node.props.onClick as () => void)();
const button = (all: El[], label: string) =>
  all.find(
    (node) =>
      node.type === "button" &&
      (node.props.children === label || node.props["aria-label"] === label),
  )!;
const fileButtons = (all: El[]) =>
  all.filter(
    (node) => node.type === "button" && node.props.children === S.open,
  );
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.cursor = 0;
  h.dirty = false;
  vi.mocked(invoke).mockClear();
  props = {
    thread: freshThreadState("a:/work:one", "a", "/work", "one"),
    scopeId: null,
    active: true,
    onOpenFile: vi.fn(),
    onOpenSource: vi.fn(),
  };
  report("one");
});
afterEach(() => {
  expect(invoke).not.toHaveBeenCalled();
});

it("renders candidate provenance without automatic file actions; explicit click passes the actual live entry", () => {
  const result = render();
  expect(props.onOpenFile).not.toHaveBeenCalled();
  const markup = renderToStaticMarkup(result.tree);
  expect(markup).toContain(S.note);
  expect(markup).toContain(S.sourceNames.location);
  expect(markup).toContain("one.md");
  click(fileButtons(result.nodes)[0]);
  expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ path: "one.md" }),
  );
  const entry = vi.mocked(props.onOpenFile).mock.calls[0][0];
  expect(isReportedArtifactCurrent(props.thread, props.scopeId, entry)).toBe(
    true,
  );
});
it("never treats visibility or default first row as user selection", () => {
  props.active = false;
  let result = render();
  expect(fileButtons(result.nodes)[0].props.disabled).toBe(true);
  click(fileButtons(result.nodes)[0]);
  props.active = true;
  result = render();
  expect(fileButtons(result.nodes)[0].props.disabled).toBe(false);
  expect(props.onOpenFile).not.toHaveBeenCalled();
});
it.each([
  "hidden",
  "unmounted",
  "scope",
  "thread",
  "cwd",
  "withdrawn",
  "replacement",
  "failed",
])("rejects an old button after %s", (change) => {
  const old = fileButtons(render().nodes)[0];
  if (change === "hidden") {
    props.active = false;
    render();
    props.active = true;
    render();
  }
  if (change === "unmounted") h.slots.forEach((slot) => slot.cleanup?.());
  if (change === "scope") {
    props.scopeId = "missing";
    render();
  }
  if (change === "thread") {
    props.thread = { ...props.thread };
    render();
  }
  if (change === "cwd") props.thread.cwd = "/other";
  if (change === "withdrawn")
    applyUpdate(props.thread, {
      sessionUpdate: "tool_call_update",
      toolCallId: "one",
      locations: [],
    });
  if (change === "replacement")
    props.thread.items[0] = { ...props.thread.items[0] };
  if (change === "failed")
    applyUpdate(props.thread, {
      sessionUpdate: "tool_call_update",
      toolCallId: "one",
      status: "failed",
    });
  click(old);
  expect(props.onOpenFile).not.toHaveBeenCalled();
});
it("has bounded file pages with exact navigation and no implicit open", () => {
  for (let i = 2; i <= 121; i++) report(String(i));
  let result = render();
  const old = fileButtons(result.nodes)[0];
  expect(fileButtons(result.nodes)).toHaveLength(50);
  click(button(result.nodes, S.next));
  result = render();
  expect(fileButtons(result.nodes)).toHaveLength(50);
  expect(fileButtons(result.nodes)[0].props["aria-label"]).toBe(
    S.openLabel("51.md"),
  );
  click(old);
  expect(props.onOpenFile).not.toHaveBeenCalled();
  click(button(result.nodes, S.next));
  result = render();
  expect(fileButtons(result.nodes)).toHaveLength(21);
  expect(button(result.nodes, S.next).props.disabled).toBe(true);
  props.thread.items = props.thread.items.slice(0, 1);
  result = render();
  expect(fileButtons(result.nodes)).toHaveLength(1);
  expect(button(result.nodes, S.previous)).toBeUndefined();
});
it("resets pagination on scope/working-directory changes, without retaining old file handlers", () => {
  for (let i = 2; i <= 60; i++) report(String(i));
  click(button(render().nodes, S.next));
  expect(fileButtons(render().nodes)).toHaveLength(10);
  props.scopeId = props.thread.items[0].id;
  expect(fileButtons(render().nodes)).toHaveLength(1);
  props.scopeId = null;
  expect(fileButtons(render().nodes)).toHaveLength(50);
  click(button(render().nodes, S.next));
  props.thread.cwd = "/other";
  expect(fileButtons(render().nodes)[0].props["aria-label"]).toBe(
    S.openLabel("one.md"),
  );
});
it("uses original exact origin objects and invalidates late source actions", () => {
  const result = render();
  const sources = result.nodes.find(
    (node) => typeof node.type === "function" && node.props.entry,
  )!;
  const entry = sources.props.entry as Parameters<typeof props.onOpenFile>[0];
  const open = sources.props.onOpen as (
    origin: (typeof entry.origins)[number],
  ) => void;
  open({ ...entry.origins[0] });
  expect(props.onOpenSource).not.toHaveBeenCalled();
  open(entry.origins[0]);
  expect(props.onOpenSource).toHaveBeenCalledExactlyOnceWith(
    entry,
    entry.origins[0],
  );
  vi.mocked(props.onOpenSource!).mockClear();
  props.active = false;
  render();
  open(entry.origins[0]);
  expect(props.onOpenSource).not.toHaveBeenCalled();
});
it("keeps unavailable scope distinct from empty completed-report list", () => {
  props.scopeId = "missing";
  let result = render();
  expect(renderToStaticMarkup(result.tree)).toContain(S.unavailable);
  expect(fileButtons(result.nodes)).toHaveLength(0);
  props.scopeId = null;
  props.thread.items = [];
  result = render();
  expect(renderToStaticMarkup(result.tree)).toContain(S.empty);
});
