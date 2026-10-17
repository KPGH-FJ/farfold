import { beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as any[],
  cleanups: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "failure-probe",
  useCallback: (value: unknown) => value,
  useState: (value: unknown) => [value, () => {}],
  useRef: (value: unknown) =>
    (hooks.slots[hooks.cursor++] ??= { current: value }),
  useLayoutEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));
import { MessageAttachmentMedia } from "./MessageAttachmentMedia";

function elements(tree: ReactNode): any[] {
  return Children.toArray(tree).flatMap((node) =>
    isValidElement<{ children?: ReactNode }>(node)
      ? [node, ...elements(node.props.children)]
      : [],
  );
}

beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.cleanups = [];
});

it.each(["image", "audio"] as const)(
  "retires a failed %s source before notifying its owner, once only",
  (kind) => {
    const src = `data:${kind === "image" ? "image/png" : "audio/wav"};base64,eA==`;
    const attributes = new Map<string, string>([["src", src]]);
    const node = {
      tagName: kind === "image" ? "IMG" : "AUDIO",
      isConnected: true,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: vi.fn((name: string, value: string) =>
        attributes.set(name, value),
      ),
      removeAttribute: vi.fn((name: string) => attributes.delete(name)),
      pause: vi.fn(),
      load: vi.fn(),
    };
    const onFailure = vi.fn(() => {
      expect(node.getAttribute("src")).toBeNull();
    });
    const media = { kind, src };
    const props = { media, name: "Original retained name", onFailure };
    const tree = elements(MessageAttachmentMedia(props));
    const element = tree.find(
      (value) => value.type === (kind === "image" ? "img" : "audio"),
    );
    element.props.ref(node);
    element.props.onError({ currentTarget: node });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(node.getAttribute("src")).toBeNull();
    if (kind === "audio") {
      expect(node.pause).toHaveBeenCalledOnce();
      expect(node.load).toHaveBeenCalledOnce();
    }
    // A late error or callback replay cannot recreate a failed source, and
    // detach must not clear or reload it again after the owner was notified.
    element.props.onError({ currentTarget: node });
    element.props.ref(null);
    element.props.ref(node);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(node.getAttribute("src")).toBeNull();
    expect(node.setAttribute).not.toHaveBeenCalled();
    expect(node.removeAttribute).toHaveBeenCalledOnce();
    expect(media).toEqual({ kind, src });
    for (const cleanup of hooks.cleanups) cleanup();
  },
);
