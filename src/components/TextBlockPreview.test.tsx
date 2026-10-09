import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("react", async (original) => {
  const effect = (fn: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++,
      slot = h.slots[index];
    if (!slot || deps.some((v, i) => !Object.is(v, slot.deps?.[i])))
      h.effects.push(() => {
        slot?.cleanup?.();
        h.slots[index].cleanup = fn() || undefined;
      });
    h.slots[index] = { deps, cleanup: slot?.cleanup };
  };
  return {
    ...(await original<typeof import("react")>()),
    useRef: (v: unknown) =>
      (h.slots[h.cursor++] ??= { value: { current: v } }).value,
    useState: (v: unknown) => {
      const slot = (h.slots[h.cursor++] ??= {
        value: typeof v === "function" ? (v as () => unknown)() : v,
      });
      return [
        slot.value,
        (v: unknown) => {
          slot.value =
            typeof v === "function"
              ? (v as (old: unknown) => unknown)(slot.value)
              : v;
        },
      ];
    },
    useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
    useEffect: effect,
  };
});
import {
  TextBlockPreview,
  type TextBlockPreviewProps,
} from "./TextBlockPreview";
import { TEXT_BLOCK_STRINGS as S } from "../runtime/text_block_strings";
const file = {
  root: "/w",
  path: "a",
  resolvedPath: "/w/a",
  name: "a",
  size: 6,
  version: "1",
  sha256: "h",
};
const initial = {
  file,
  blockIndex: 0,
  blockCount: 2,
  byteStart: 0,
  byteEnd: 3,
  startLine: 1,
  endLine: 1,
  startsMidLine: false,
  endsMidLine: true,
  text: "abc",
};
let props: TextBlockPreviewProps;
function elements(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(tree, (c) => {
    if (isValidElement<Record<string, unknown>>(c))
      result.push(c, ...elements(c.props.children as ReactNode));
  });
  return result;
}
function render(next = props) {
  props = next;
  h.cursor = 0;
  const tree = TextBlockPreview(props);
  for (const effect of h.effects.splice(0)) effect();
  return { html: renderToStaticMarkup(tree), nodes: elements(tree) };
}
function click(label: string) {
  const b = render().nodes.find(
    (n) => n.type === "button" && n.props.children === label,
  )!;
  expect(b).toBeDefined();
  expect(b.props.disabled).not.toBe(true);
  (b.props.onClick as () => void)();
}
const drain = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.invoke.mockReset();
  h.copy.mockReset();
  props = { initial, active: true };
  vi.stubGlobal("navigator", { clipboard: { writeText: h.copy } });
});
it("successful same-version reload replaces prior failed reader state", async () => {
  render();
  h.invoke.mockRejectedValue({ code: "pending" });
  click(S.next);
  await drain();
  expect(render().html).toContain(S.failures.pending);
  const loaded = { ...initial };
  render({ ...props, initial: loaded });
  expect(render().html).not.toContain(S.failures.pending);
  expect(render().html).toContain("abc");
});
it("a late clipboard result cannot label a subsequently reloaded fragment", async () => {
  let done!: () => void;
  h.copy.mockReturnValue(new Promise<void>((r) => (done = r)));
  render();
  click(S.copy);
  render({ ...props, initial: { ...initial, text: "xyz" } });
  done();
  await drain();
  expect(render().html).not.toContain(S.copied);
});
it("never treats markup or unsupported scalar content as rendered HTML", () => {
  const html = render({
    ...props,
    initial: { ...initial, text: "<img src='https://example.com/private'>" },
  }).html;
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(h.invoke).not.toHaveBeenCalled();
});
