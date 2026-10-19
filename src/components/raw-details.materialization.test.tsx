import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  active: false,
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
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { threads } from "../runtime/sessions";
import { RawBlock } from "./thread-items";
import { ReportedDetails } from "./ReportedDetails";
import { SearchDisclosure } from "./transcript-search";
import { STRINGS } from "../runtime/strings";
type Element = ReactElement<Record<string, any>>;
const keys: string[] = [];
let sequence = 0;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, any>>(node))
      result.push(node, ...nodes(node.props.children));
  });
  return result;
}
function render(scope: string, element: ReactNode) {
  h.scope = scope;
  h.cursor = 0;
  if (!h.slots.has(scope)) h.slots.set(scope, []);
  if (!isValidElement<Parameters<typeof SearchDisclosure>[0]>(element))
    throw new Error("missing actual disclosure element");
  return SearchDisclosure(element.props);
}
function fixture() {
  const key = `raw-materialization-${++sequence}`;
  const state = threads.markOpenFailed(
    key,
    "owned-render",
    "/owned-render",
    key,
    "fixture",
  );
  keys.push(key);
  state.openError = null;
  const update = {
    sessionUpdate: "future_plain_json",
    text: "x".repeat(16 * 1024),
    tail: [null, false, 0, "中文🙂", { untouched: true }],
  };
  // Actual store/normalizer path, not a copied raw buffer implementation.
  (
    threads as unknown as {
      applyChannelEvent(key: string, value: unknown): void;
    }
  ).applyChannelEvent(key, { sessionId: key, update });
  const item = state.items.find((item) => item.kind === "raw");
  if (item?.kind !== "raw") throw new Error("missing actual unknown item");
  expect(item.update).toBe(update);
  return { state, item, update };
}
beforeEach(() => {
  h.active = false;
  h.slots.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of keys.splice(0)) await threads.close(key);
});
// Real SearchDisclosure/useSearchExpansion/SearchExpansion model; only React
// hook slots are controlled, following the existing search-expansion harness.
// No DOM commit, official IPC, SDK, browser latency or RSS is claimed.
it("does not serialize or mount collapsed raw bodies across repeated real-store renders", () => {
  const rows = Array.from({ length: 8 }, fixture);
  const before = rows.map(({ update }) => structuredClone(update));
  const spy = vi.spyOn(JSON, "stringify");
  for (let pass = 0; pass < 3; pass++)
    for (const { state, item } of rows) {
      const tree = render(state.key, RawBlock({ update: item.update }));
      expect(nodes(tree).some((node) => node.type === "pre")).toBe(false);
      expect(
        nodes(tree).find((node) => node.type === "summary")?.props.children,
      ).toBe(STRINGS.thread.rawUpdate);
    }
  expect(
    spy.mock.calls.filter(([value]) =>
      rows.some(({ update }) => value === update),
    ),
  ).toHaveLength(0);
  rows.forEach(({ item, update }, i) => {
    expect(item.update).toBe(update);
    expect(update).toEqual(before[i]);
  });
});
it("explicit open materializes the full current raw value and collapse retires its body", () => {
  const { state, item, update } = fixture();
  const expected = JSON.stringify(update, null, 2);
  const draw = () => render(state.key, RawBlock({ update: item.update }));
  const closed = draw();
  closed.props.onToggle({ currentTarget: { open: true } });
  const spy = vi.spyOn(JSON, "stringify");
  const opened = draw();
  expect(
    nodes(opened).find((node) => node.type === "pre")?.props.children,
  ).toBe(expected);
  expect(spy.mock.calls.filter(([value]) => value === update)).toHaveLength(1);
  opened.props.onToggle({ currentTarget: { open: false } });
  spy.mockClear();
  expect(nodes(draw()).some((node) => node.type === "pre")).toBe(false);
  expect(spy.mock.calls.filter(([value]) => value === update)).toHaveLength(0);
  expect(item.update).toBe(update);
});
it("search materializes a closed body without changing the user's open preference", () => {
  const { state, item, update } = fixture();
  const expected = JSON.stringify(update, null, 2);
  const draw = () => render(state.key, RawBlock({ update: item.update }));
  const closed = draw();
  expect(closed.props.open).toBe(false);
  h.active = true;
  const searched = draw();
  expect(searched.props.open).toBe(false);
  expect(
    nodes(searched).find((node) => node.type === "pre")?.props.children,
  ).toBe(expected);
  h.active = false;
  expect(nodes(draw()).some((node) => node.type === "pre")).toBe(false);
  draw().props.onToggle({ currentTarget: { open: true } });
  h.active = true;
  draw();
  h.active = false;
  expect(draw().props.open).toBe(true);
});
it("reported fields share the same gate without mutating or truncating extension data", () => {
  const details = {
    "/future": { tail: "z".repeat(16 * 1024), kept: [0, false, null] },
  };
  const expected = JSON.stringify(details, null, 2);
  const spy = vi.spyOn(JSON, "stringify");
  const draw = () => render("fields", ReportedDetails({ details }));
  expect(nodes(draw()).some((node) => node.type === "pre")).toBe(false);
  expect(spy.mock.calls.filter(([value]) => value === details)).toHaveLength(0);
  h.active = true;
  expect(
    nodes(draw()).find((node) => node.type === "pre")?.props.children,
  ).toBe(expected);
  expect(spy.mock.calls.filter(([value]) => value === details)).toHaveLength(1);
  h.active = false;
  expect(nodes(draw()).some((node) => node.type === "pre")).toBe(false);
});
