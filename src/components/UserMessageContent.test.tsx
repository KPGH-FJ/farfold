import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as any[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (read: () => unknown) => read(),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [slot.value, (value: unknown) => (slot.value = value)];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (!slot.deps || deps.some((value, index) => value !== slot.deps[index])) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect();
      });
      slot.deps = deps;
    }
  },
}));
import { TextMessageImage, UserMessageContent } from "./UserMessageContent";
import {
  textImageParts,
  type TextImagePart,
} from "../runtime/text_image_links";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "../runtime/image_fixtures.test-support";

type Candidate = Extract<TextImagePart, { kind: "image" }>;
type Element = ReactElement<Record<string, any>>;
const link = `[@image](data:image/png;base64,${PNG_IMAGE_TEST_DATA})`;
const candidate = () => textImageParts(link)[0] as Candidate;
const finishes: (() => void)[] = [];
function nodes(tree: ReactNode): Element[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, any>>(child)
      ? [child, ...nodes(child.props.children)]
      : [],
  );
}
function render(image = candidate()): Element[] {
  for (let pass = 0; pass < 5; pass++) {
    h.cursor = 0;
    const tree = nodes(TextMessageImage({ image }));
    if (!h.effects.length) return tree;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("Unsettled test layout effects");
}
function toggle(tree: Element[], open: boolean) {
  tree
    .find((node) => node.type === "details")!
    .props.onToggle({
      currentTarget: { open },
    });
}
function heldDecoder() {
  const decode = vi.fn();
  vi.stubGlobal(
    "Image",
    class extends TestImageDecoder {
      override decode() {
        decode(this.src);
        return new Promise<void>((resolve) => finishes.push(resolve));
      }
    },
  );
  return decode;
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.invoke.mockReset();
});
afterEach(async () => {
  for (const slot of h.slots) slot.cleanup?.();
  for (const finish of finishes.splice(0)) finish();
  await Promise.resolve();
  await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps current user text literal and historical images unopened without any decoding or IPC", () => {
  const image = vi.fn();
  vi.stubGlobal("Image", image);
  const current = renderToStaticMarkup(
    <UserMessageContent text={link} historical={false} />,
  );
  expect(current).toContain("[@image]");
  expect(current).not.toContain("<details");
  const historical = renderToStaticMarkup(
    <UserMessageContent text={`Original ${link} after`} historical />,
  );
  expect(historical).toContain("Original ");
  expect(historical).toContain(" after");
  expect(historical).toContain("历史图片");
  expect(historical).not.toContain("data:image");
  expect(historical).not.toContain("<img");
  expect(image).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("passes exact image bytes through the production validator only on explicit expansion", async () => {
  const decode = heldDecoder();
  const image = candidate();
  const before = structuredClone(image);
  let tree = render(image);
  expect(decode).not.toHaveBeenCalled();
  toggle(tree, true);
  tree = render(image);
  expect(tree.some((node) => node.type === "img")).toBe(false);
  // A repeated native toggle while this exact check is pending is not a retry.
  toggle(tree, true);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  expect(decode).toHaveBeenCalledWith(`data:image/png;base64,${image.data}`);
  finishes.shift()!();
  await vi.waitFor(() => {
    tree = render(image);
    expect(tree.find((node) => node.type === "img")?.props.src).toBe(
      `data:image/png;base64,${image.data}`,
    );
  });
  toggle(tree, false);
  expect(render(image).some((node) => node.type === "img")).toBe(false);
  expect(image).toEqual(before);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("rejects malformed image bytes before decoding and retains an explicit failure item", async () => {
  const decode = vi.fn();
  vi.stubGlobal("Image", decode);
  const image = { ...candidate(), data: btoa("signature only, not PNG") };
  toggle(render(image), true);
  await vi.waitFor(() =>
    expect(render(image).some((node) => node.props.role === "alert")).toBe(
      true,
    ),
  );
  expect(render(image).some((node) => node.type === "img")).toBe(false);
  expect(render(image).some((node) => node.type === "details")).toBe(true);
  expect(decode).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("ignores an old validation after the same display position changes image identity", async () => {
  const decode = heldDecoder();
  const first = candidate();
  toggle(render(first), true);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  const second = { ...first, mimeType: "image/jpeg" as const };
  expect(render(second).some((node) => node.type === "img")).toBe(false);
  finishes.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(render(second).some((node) => node.type === "img")).toBe(false);
  toggle(render(second), true);
  await vi.waitFor(() =>
    expect(render(second).some((node) => node.props.role === "alert")).toBe(
      true,
    ),
  );
  expect(decode).toHaveBeenCalledOnce();
  expect(render(second).some((node) => node.type === "img")).toBe(false);
});

it("retains the shared two decoder slots after timeout and never applies a closed check", async () => {
  vi.useFakeTimers();
  const decode = heldDecoder();
  const image = candidate();
  for (let at = 0; at < 3; at++) {
    toggle(render(image), true);
    await Promise.resolve();
    await Promise.resolve();
    toggle(render(image), false);
  }
  expect(decode).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15_000);
  toggle(render(image), true);
  await Promise.resolve();
  await Promise.resolve();
  expect(decode).toHaveBeenCalledTimes(2);
  expect(render(image).some((node) => node.type === "img")).toBe(false);
  expect(render(image).some((node) => node.props.role === "alert")).toBe(true);
  for (const finish of finishes.splice(0)) finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(render(image).some((node) => node.type === "img")).toBe(false);
});

it("keeps attachment keyboard handling local without preventing native expansion", () => {
  const wrapper = render()[0];
  for (const key of ["Enter", "Backspace", " ", "Escape"]) {
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    wrapper.props.onKeyDown({ key, stopPropagation, preventDefault });
    expect(stopPropagation).toHaveBeenCalledTimes(
      key === "Enter" || key === "Backspace" ? 1 : 0,
    );
    expect(preventDefault).not.toHaveBeenCalled();
  }
});
