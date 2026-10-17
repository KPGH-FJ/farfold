import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

// Component/event checks. Actual image decoding and native audio playback
// are covered separately by the controlled real-browser fixture.
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as any[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "media-error",
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (value: unknown) => {
        slot.value = typeof value === "function" ? value(slot.value) : value;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (!slot.deps || deps.some((value, i) => value !== slot.deps[i])) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect();
      });
      slot.deps = deps;
    }
  },
}));
import { MessageAttachmentMedia } from "./MessageAttachmentMedia";
import { attachmentMedia } from "../runtime/message_attachments";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";

type Element = ReactElement<Record<string, any>>;
type Media = NonNullable<ReturnType<typeof attachmentMedia>>;
const image: Media = { kind: "image", src: "data:image/png;base64,aW1hZ2U=" };
const audio: Media = { kind: "audio", src: "data:audio/wav;base64,YXVkaW8=" };
function nodes(tree: ReactNode): Element[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, any>>(child)
      ? [child, ...nodes(child.props.children)]
      : [],
  );
}
function render(media: Media = image) {
  h.cursor = 0;
  const tree = nodes(MessageAttachmentMedia({ media, name: "original name" }));
  for (const effect of h.effects.splice(0)) effect();
  return tree;
}
function element(tree: Element[], type: string) {
  return tree.find((n) => n.type === type)!;
}
function attach(tree: Element[], kind: "img" | "audio") {
  const attributes = new Map([["src", element(tree, kind).props.src]]);
  const node = {
    isConnected: true,
    tagName: kind.toUpperCase(),
    pause: vi.fn(),
    getAttribute: vi.fn((key: string) => attributes.get(key) ?? null),
    setAttribute: vi.fn((key: string, value: string) =>
      attributes.set(key, value),
    ),
    removeAttribute: vi.fn((key: string) => attributes.delete(key)),
    load: vi.fn(),
  };
  element(tree, kind).props.ref(node);
  return node;
}
function fail(tree: Element[], kind: "img" | "audio", node: unknown) {
  element(tree, kind).props.onError({ currentTarget: node });
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.unstubAllGlobals();
});

it.each([
  [image, "img", S.imageFailed],
  [audio, "audio", S.audioFailed],
] as const)(
  "reports the actual %s element error without discarding its source",
  (media, kind, message) => {
    let tree = render(media);
    const before = structuredClone(media);
    expect(tree.some((n) => n.props.role === "status")).toBe(false);
    expect(tree.some((n) => n.type === "button")).toBe(false);
    const node = attach(tree, kind);
    fail(tree, kind, node);
    tree = render(media);
    expect(tree.find((n) => n.props.role === "status")?.props.children).toBe(
      message,
    );
    expect(element(tree, kind).props.src).toBe(media.src);
    expect(element(tree, kind).props["aria-describedby"]).toBe("media-error");
    expect(element(tree, "button").props.children).toBe(S.retryMedia);
    expect(media).toEqual(before);
  },
);

it("reloads only the admitted bytes once per explicit retry and rejects the previous node", () => {
  let tree = render();
  const old = attach(tree, "img");
  fail(tree, "img", old);
  tree = render();
  const retry = element(tree, "button").props.onClick;
  const button = { isConnected: true };
  vi.stubGlobal("document", { activeElement: button });
  const wrapper = { isConnected: true, focus: vi.fn() };
  element(tree, "div").props.ref.current = wrapper;
  retry({ currentTarget: button });
  retry({ currentTarget: button });
  tree = render();
  expect(element(tree, "img").key).toBe(".$1");
  expect(element(tree, "img").props.src).toBe(image.src);
  expect(tree.some((n) => n.props.role === "status")).toBe(false);
  expect(wrapper.focus).toHaveBeenCalledOnce();
  const next = attach(tree, "img");
  fail(tree, "img", old);
  expect(render().some((n) => n.props.role === "status")).toBe(false);
  fail(tree, "img", next);
  expect(render().some((n) => n.props.role === "status")).toBe(true);
});

it("does not steal focus when the user moved away from retry", () => {
  let tree = render();
  fail(tree, "img", attach(tree, "img"));
  tree = render();
  vi.stubGlobal("document", { activeElement: {} });
  const wrapper = { isConnected: true, focus: vi.fn() };
  element(tree, "div").props.ref.current = wrapper;
  element(tree, "button").props.onClick({
    currentTarget: { isConnected: true },
  });
  expect(wrapper.focus).not.toHaveBeenCalled();
});

it("ignores detached errors and retired handlers after unmount", () => {
  const tree = render();
  const node = attach(tree, "img");
  node.isConnected = false;
  fail(tree, "img", node);
  expect(render().some((n) => n.props.role === "status")).toBe(false);
  for (const slot of h.slots) slot.cleanup?.();
  node.isConnected = true;
  fail(tree, "img", node);
  expect(render().some((n) => n.props.role === "status")).toBe(false);
});

it("keeps audio user-initiated and releases only its own detached element", () => {
  const tree = render(audio);
  const node = attach(tree, "audio");
  expect(element(tree, "audio").props.preload).toBe("none");
  expect(element(tree, "audio").props.autoPlay).toBeUndefined();
  expect(element(tree, "audio").props.controls).toBe(true);
  expect(element(tree, "audio").props["aria-label"]).toBe("original name");
  element(tree, "audio").props.ref(null);
  expect(node.pause).toHaveBeenCalledOnce();
  expect(node.removeAttribute).toHaveBeenCalledWith("src");
  expect(node.load).toHaveBeenCalledOnce();
});

it("retains the existing no-fetch and inert media input boundary", () => {
  expect(
    attachmentMedia({
      name: "remote",
      uri: "https://example.com/a.png",
      mimeType: "image/png",
    }),
  ).toBeNull();
  expect(
    attachmentMedia({
      name: "active",
      data: "eA==",
      mimeType: "image/svg+xml",
    }),
  ).toBeNull();
  expect(
    attachmentMedia({
      name: "invalid",
      data: "<script>",
      mimeType: "audio/wav",
    }),
  ).toBeNull();
});

it("reattaches the same audio element with only its admitted src after a ref replay", () => {
  const tree = render(audio);
  const node = attach(tree, "audio");
  const ref = element(tree, "audio").props.ref;
  expect(node.setAttribute).not.toHaveBeenCalled();
  ref(null);
  expect(node.getAttribute("src")).toBeNull();
  ref(node);
  expect(node.getAttribute("src")).toBe(audio.src);
  expect(node.setAttribute).toHaveBeenCalledExactlyOnceWith("src", audio.src);
  expect(node.pause).toHaveBeenCalledOnce();
  expect(element(tree, "audio").props.autoPlay).toBeUndefined();
});

it("clears only its retired image source when a preview detaches", () => {
  const tree = render(image);
  const node = attach(tree, "img");
  const ref = element(tree, "img").props.ref;
  ref(null);
  expect(node.getAttribute("src")).toBeNull();
  expect(node.removeAttribute).toHaveBeenCalledExactlyOnceWith("src");
  expect(node.pause).not.toHaveBeenCalled();
  expect(node.load).not.toHaveBeenCalled();
  // Repeating cleanup does not reload or touch the retired element twice.
  ref(null);
  expect(node.removeAttribute).toHaveBeenCalledOnce();
  expect(node.setAttribute).not.toHaveBeenCalled();
});

it("restores the exact admitted image source on the same node after ref replay", () => {
  const tree = render(image);
  const node = attach(tree, "img");
  const ref = element(tree, "img").props.ref;
  expect(node.setAttribute).not.toHaveBeenCalled();
  ref(null);
  expect(node.getAttribute("src")).toBeNull();
  ref(node);
  expect(node.getAttribute("src")).toBe(image.src);
  expect(node.setAttribute).toHaveBeenCalledExactlyOnceWith("src", image.src);
  expect(node.pause).not.toHaveBeenCalled();
  expect(node.load).not.toHaveBeenCalled();
});
