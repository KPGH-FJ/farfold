import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({
  realReact: false,
  active: false,
  cursor: 0,
  scope: "",
  slots: new Map<string, unknown[]>(),
  ipc: 0,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useContext: (...args: Parameters<typeof actual.useContext>) =>
      h.realReact ? Reflect.apply(actual.useContext, actual, args) : h.active,
    useRef: (initial: unknown) => {
      if (h.realReact) return actual.useRef(initial);
      const slots = h.slots.get(h.scope)!;
      return (slots[h.cursor++] ??= { current: initial });
    },
    useState: (initial: unknown) => {
      if (h.realReact) return actual.useState(initial);
      const slots = h.slots.get(h.scope)!,
        index = h.cursor++;
      slots[index] ??= initial;
      return [
        slots[index],
        (next: unknown) => {
          slots[index] = typeof next === "function" ? next(slots[index]) : next;
        },
      ];
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => {
    h.ipc++;
    return Promise.reject(Error("Unexpected IPC"));
  },
  Channel: class {},
}));
import { ApprovalCard, ToolStep } from "./thread-items";
import { SearchDisclosure } from "./transcript-search";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";
import type { ToolCallView } from "../runtime/session_types";
type Element = ReactElement<Record<string, any>>;
const descriptor = Object.getOwnPropertyDescriptor(JSON, "stringify")!;
const nativeStringify = descriptor.value as typeof JSON.stringify;
let input: { command: string; cwd: string; payload: string; tail: unknown[] };
let call: ToolCallView;
let expected: string;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, any>>(node))
      result.push(node, ...nodes(node.props.children));
  });
  return result;
}
function scope<T>(name: string, read: () => T): T {
  h.scope = name;
  h.cursor = 0;
  if (!h.slots.has(name)) h.slots.set(name, []);
  return read();
}
function callElement(element: Element): ReactNode {
  if (typeof element.type !== "function")
    throw Error("Actual component element unavailable");
  return (element.type as (props: Record<string, any>) => ReactNode)(
    element.props,
  );
}
// Actual ToolStep.choose -> actual returned private ToolDetail -> ToolInput.
// No serializer/disclosure/model copy. The private chain controls hook slots, not a DOM commit.
// The SSR case delegates these hooks to the actual React dispatcher.
function draw() {
  const tool = scope("tool", () => ToolStep({ call }));
  const detailElement = nodes(tool).find(
    (node) => typeof node.type === "function" && node.props.call === call,
  );
  if (!detailElement) {
    h.slots.delete("input");
    return { tool, detail: null, inputTree: null, disclosure: null };
  }
  const detail = callElement(detailElement);
  const inputElement = nodes(detail).find(
    (node) => typeof node.type === "function" && node.props.input === input,
  );
  if (!inputElement) throw Error("Actual ToolInput element unavailable");
  const inputTree = callElement(inputElement);
  const element = nodes(inputTree).find(
    (node) => node.type === SearchDisclosure,
  );
  if (!element) throw Error("Actual inner SearchDisclosure unavailable");
  const disclosure = scope("input", () => SearchDisclosure(element.props));
  return { tool, detail, inputTree, disclosure };
}
function openTool() {
  const closed = draw();
  const buttons = nodes(closed.tool).filter(
    (node) =>
      node.type === "button" &&
      typeof node.props.onClick === "function" &&
      Object.hasOwn(node.props, "aria-expanded"),
  );
  if (buttons.length !== 1)
    throw Error("Unique actual ToolStep detail button unavailable");
  buttons[0].props.onClick();
  return draw();
}
function measured<T>(action: () => T) {
  let calls = 0;
  Object.defineProperty(JSON, "stringify", {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      if (args[0] === input) calls++;
      return Reflect.apply(nativeStringify, this, args);
    },
  });
  try {
    return { value: action(), calls };
  } finally {
    Object.defineProperty(JSON, "stringify", descriptor);
  }
}
function body(tree: ReactNode) {
  return nodes(tree).find((node) => node.type === "pre");
}
beforeEach(() => {
  h.realReact = false;
  h.active = false;
  h.cursor = 0;
  h.scope = "";
  h.slots.clear();
  h.ipc = 0;
  input = {
    command: "printf OWNED_REVIEW_ONLY",
    cwd: "/owned/no-disk-access",
    payload: "DEEP_TOOL_PAYLOAD_957:" + "x".repeat(16 * 1024),
    tail: [null, false, 0, "中文🙂", { untouched: true }],
  };
  expected = nativeStringify(input, null, 2);
  const state = freshThreadState(
    "owned-tool-input",
    "controlled",
    "/owned/no-disk-access",
    "owned-not-a-session",
  );
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "owned-call",
    title: "Owned tool",
    kind: "execute",
    status: "completed",
    rawInput: input,
    locations: [],
    content: [],
  });
  const item = state.items.find((item) => item.kind === "tool");
  if (!item || item.kind !== "tool")
    throw Error("Actual projected tool unavailable");
  call = item.call;
  if (call.rawInput !== input)
    throw Error("Original input identity lost before rendering");
});
afterEach(() => {
  try {
    expect(JSON.stringify).toBe(nativeStringify);
    expect(h.ipc).toBe(0);
    expect(call.rawInput).toBe(input);
    expect(nativeStringify(input, null, 2)).toBe(expected);
  } finally {
    h.realReact = false;
    vi.restoreAllMocks();
  }
});

it("actual ApprovalCard SSR keeps full input closed and unmaterialized while command and cwd remain readable", () => {
  h.realReact = true;
  let row: { value: string; calls: number };
  try {
    row = measured(() =>
      renderToStaticMarkup(
        <ApprovalCard
          title="Owned approval"
          kind="execute"
          locations={[]}
          rawInput={input}
          options={[]}
          onPick={() => {
            throw Error("No approval action allowed");
          }}
        />,
      ),
    );
  } finally {
    h.realReact = false;
  }
  expect(row.value).toContain(input.command);
  expect(row.value).toContain(input.cwd);
  expect(row.value).not.toMatch(/<details[^>]*\sopen(?:[ =>])/);
  expect(row.calls).toBe(0);
  expect(row.value).not.toContain("DEEP_TOOL_PAYLOAD_957");
});

it("actual outer ToolStep starts closed and its own button keeps ordinary command and cwd intact", () => {
  const closed = measured(draw);
  expect(closed.calls).toBe(0);
  expect(closed.value.disclosure).toBeNull();
  const opened = openTool();
  expect(
    nodes(opened.inputTree)
      .filter(
        (node) => node.type === "pre" && node.props.className === "step-text",
      )
      .map((node) => node.props.children),
  ).toEqual([input.command, input.cwd]);
  expect(opened.disclosure?.props.open).toBe(false);
});

it("open outer details do not stringify a still-closed full-input body on repeated renders", () => {
  openTool();
  const measuredRows = Array.from({ length: 3 }, () => measured(draw));
  expect(measuredRows.map((row) => row.calls)).toEqual([0, 0, 0]);
  for (const row of measuredRows)
    expect(body(row.value.disclosure)).toBeUndefined();
});

it("explicit inner open serializes the complete original once and collapse retires its body", () => {
  const initial = openTool();
  initial.disclosure!.props.onToggle({ currentTarget: { open: true } });
  const opened = measured(draw);
  opened.value.disclosure!.props.onToggle({ currentTarget: { open: false } });
  const collapsed = measured(draw);
  expect(opened.calls).toBe(1);
  expect(body(opened.value.disclosure)?.props.children).toBe(expected);
  expect(collapsed.calls).toBe(0);
  expect(body(collapsed.value.disclosure)).toBeUndefined();
});

it("search materializes a closed full input without user-open and exiting search restores it", () => {
  openTool();
  h.active = true;
  const search = measured(draw);
  h.active = false;
  const exited = measured(draw);
  expect(search.value.disclosure?.props.open).toBe(false);
  expect(search.calls).toBe(1);
  expect(body(search.value.disclosure)?.props.children).toBe(expected);
  expect(exited.value.disclosure?.props.open).toBe(false);
  expect(exited.calls).toBe(0);
  expect(body(exited.value.disclosure)).toBeUndefined();
});

it("search exit preserves an explicitly opened inner user preference", () => {
  const initial = openTool();
  initial.disclosure!.props.onToggle({ currentTarget: { open: true } });
  h.active = true;
  measured(draw);
  h.active = false;
  const exited = measured(draw);
  expect(exited.value.disclosure?.props.open).toBe(true);
  expect(exited.calls).toBe(1);
  expect(body(exited.value.disclosure)?.props.children).toBe(expected);
  const button = nodes(exited.value.tool).find(
    (node) =>
      node.type === "button" && Object.hasOwn(node.props, "aria-expanded"),
  );
  button!.props.onClick();
  const outerClosed = measured(draw);
  expect(outerClosed.calls).toBe(0);
  expect(outerClosed.value.disclosure).toBeNull();
});
