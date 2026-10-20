import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Existing component-test seam: persisted hook state and explicitly committed
// layout effects. React's Context/Provider/useContext and SSR are real. Native
// Image.decode alone is a controlled 2x1 peer; this is not a browser/RSS probe.
const h = vi.hoisted(() => ({
  active: null as any,
  invoke: vi.fn(),
  instances: [] as any[],
  decodeSources: [] as string[],
  created: 0,
  hold: false,
  finishes: [] as (() => void)[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const slot = () => (h.active.slots[h.active.cursor++] ??= {});
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  return {
    ...actual,
    useState: (initial: unknown) => {
      const s = slot();
      if (!("value" in s))
        s.value = typeof initial === "function" ? initial() : initial;
      return [
        s.value,
        (value: unknown) => {
          s.value = typeof value === "function" ? value(s.value) : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const s = slot();
      return (s.value ??= { current: initial });
    },
    useMemo: (read: () => unknown, deps?: unknown[]) => {
      const s = slot();
      if (changed(s.deps, deps)) {
        s.value = read();
        s.deps = deps?.slice();
      }
      return s.value;
    },
    useCallback: (fn: unknown, deps?: unknown[]) => {
      const s = slot();
      if (changed(s.deps, deps)) {
        s.value = fn;
        s.deps = deps?.slice();
      }
      return s.value;
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const s = slot();
      if (changed(s.deps, deps)) {
        h.active.effects.push(() => {
          s.cleanup?.();
          s.cleanup = effect();
        });
        s.deps = deps?.slice();
      }
    },
  };
});
// Run the real shared renderer in a separately persisted hook scope. This
// changes no renderer behavior: actual refs/onError are committed below with
// the same explicit element peer used by MessageAttachmentMedia tests.
vi.mock("./MessageAttachmentMedia", async (original) => {
  const actual = await original<typeof import("./MessageAttachmentMedia")>();
  return {
    ...actual,
    MessageAttachmentMedia: (
      props: Parameters<typeof actual.MessageAttachmentMedia>[0],
    ) => {
      const parent = h.active;
      const scope = (parent.media ??= hooks());
      scope.cursor = 0;
      scope.visited = true;
      scope.nextImage = null;
      h.active = scope;
      try {
        return actual.MessageAttachmentMedia(props);
      } finally {
        h.active = parent;
      }
    },
  };
});
function capture(kind: unknown, value: unknown) {
  const props =
    value && typeof value === "object"
      ? (value as Record<string, any>)
      : undefined;
  if (!h.active) return;
  if (kind === "details" && props?.className === "message-attachment")
    h.active.toggle = props.onToggle;
  if (kind === "details" && props?.id === "owned-disclosure")
    h.active.disclosure = props.onToggle;
  if (kind === "div" && props?.className === "message-attachments")
    h.active.keyDown = props.onKeyDown;
  if (kind === "button" && props?.children === "重新载入")
    h.active.retry = props.onClick;
  if (kind === "img") h.active.nextImage = props;
}
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  return {
    ...actual,
    jsx: (...args: Parameters<typeof actual.jsx>) => {
      capture(args[0], args[1]);
      return actual.jsx(...args);
    },
    jsxs: (...args: Parameters<typeof actual.jsxs>) => {
      capture(args[0], args[1]);
      return actual.jsxs(...args);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      capture(args[0], args[1]);
      return actual.jsxDEV(...args);
    },
  };
});

import { TextMessageImage, UserMessageContent } from "./UserMessageContent";
import { MessageMediaVisibility } from "./message-media-visibility";
import { SearchDisclosure } from "./transcript-search";
import {
  textImageParts,
  type TextImagePart,
} from "../runtime/text_image_links";
import {
  messageMediaBudget,
  MAX_ACTIVE_MESSAGE_MEDIA,
  type MessageMediaLease,
} from "../runtime/message_media_budget";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "../runtime/image_fixtures.test-support";

type Candidate = Extract<TextImagePart, { kind: "image" }>;
const original = `Before [@image](data:image/png;base64,${PNG_IMAGE_TEST_DATA}) after`;
const held: MessageMediaLease[] = [];
function candidate(offset = 0): Candidate {
  const part = textImageParts(original).find(
    (p) => p.kind === "image",
  ) as Candidate;
  return Object.freeze({ ...part, offset: part.offset + offset });
}
function freeSlots() {
  const leases = [];
  try {
    for (let i = 0; i < MAX_ACTIVE_MESSAGE_MEDIA; i++) {
      const lease = messageMediaBudget.acquire(1);
      if (lease) leases.push(lease);
    }
    return leases.length;
  } finally {
    for (const lease of leases) lease.release();
  }
}
function fill() {
  for (let i = 0; i < MAX_ACTIVE_MESSAGE_MEDIA; i++) {
    const lease = messageMediaBudget.acquire(1);
    expect(lease).not.toBeNull();
    held.push(lease!);
  }
  expect(freeSlots()).toBe(0);
}
function hooks() {
  return {
    slots: [] as any[],
    cursor: 0,
    effects: [] as (() => void)[],
    toggle: null as any,
    disclosure: null as any,
    keyDown: null as any,
    retry: null as any,
    media: null as any,
    nextImage: null as any,
    image: null as any,
    node: null as any,
    visited: false,
  };
}
function cleanup(scope: ReturnType<typeof hooks>) {
  if (scope.media) {
    cleanup(scope.media);
    scope.media = null;
  }
  if (scope.image) {
    scope.image.ref(null);
    scope.node.isConnected = false;
    scope.image = null;
  }
  for (const slot of scope.slots) slot.cleanup?.();
  scope.slots = [];
  scope.effects = [];
}
function commitMedia(parent: ReturnType<typeof hooks>) {
  const scope = parent.media;
  if (!scope) return;
  if (!scope.visited) {
    cleanup(scope);
    parent.media = null;
    return;
  }
  const next = scope.nextImage;
  if (!next) throw Error("Real media renderer did not produce its exact image");
  if (!scope.node) {
    const attributes = new Map<string, string>([["src", next.src]]);
    scope.node = {
      isConnected: true,
      tagName: "IMG",
      pause: vi.fn(),
      load: vi.fn(),
      getAttribute: vi.fn((name: string) => attributes.get(name) ?? null),
      setAttribute: vi.fn((name: string, value: string) =>
        attributes.set(name, value),
      ),
      removeAttribute: vi.fn((name: string) => attributes.delete(name)),
    };
    next.ref(scope.node);
  } else if (scope.image?.ref !== next.ref) {
    scope.image?.ref(null);
    next.ref(scope.node);
  }
  scope.image = next;
  for (const effect of scope.effects.splice(0)) effect();
}
function owner(image = candidate(), disclosure = false) {
  const value = {
    ...hooks(),
    visible: true,
    html: "",
    imageCandidate: image,
    original: JSON.stringify(image),
    unmounted: false,
  };
  h.instances.push(value);
  const render = () => {
    if (value.unmounted) throw Error("Unmounted test owner cannot render");
    for (let pass = 0; pass < 8; pass++) {
      h.active = value;
      value.cursor = 0;
      value.toggle = null;
      value.disclosure = null;
      value.retry = null;
      if (value.media) value.media.visited = false;
      const imageNode = <TextMessageImage image={value.imageCandidate} />;
      value.html = renderToStaticMarkup(
        <MessageMediaVisibility visible={value.visible}>
          <MessageMediaVisibility visible>
            {disclosure ? (
              <SearchDisclosure id="owned-disclosure">
                <summary>Original folded result</summary>
                {imageNode}
              </SearchDisclosure>
            ) : (
              imageNode
            )}
          </MessageMediaVisibility>
        </MessageMediaVisibility>,
      );
      // Ref detachment precedes the parent layout cleanup/lease release.
      commitMedia(value);
      if (!value.effects.length) {
        h.active = null;
        return value.html;
      }
      for (const effect of value.effects.splice(0)) effect();
    }
    throw Error("Unsettled hook layout seam");
  };
  return {
    value,
    render,
    open: () => {
      render();
      value.toggle({ currentTarget: { open: true } });
      render();
    },
    close: () => {
      render();
      value.toggle({ currentTarget: { open: false } });
      render();
    },
    visible: (visible: boolean) => {
      value.visible = visible;
      return render();
    },
    fold: (open: boolean) => {
      render();
      value.disclosure({ currentTarget: { open } });
      return render();
    },
    change: (next: Candidate) => {
      value.imageCandidate = next;
      return render();
    },
    retry: () => {
      render();
      expect(value.retry).toBeTypeOf("function");
      value.retry({ currentTarget: { isConnected: true } });
      return render();
    },
    unmount: () => {
      cleanup(value);
      value.unmounted = true;
    },
  };
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function observe(name: string, entries: ReturnType<typeof owner>[]) {
  const html = entries.map((entry) => entry.render()).join("\n");
  const row = {
    name,
    images: (html.match(/<img\b/g) ?? []).length,
    sourceExact: html.includes(`data:image/png;base64,${PNG_IMAGE_TEST_DATA}`),
    decodeCalls: h.decodeSources.length,
    createdImages: h.created,
    freeSlots: freeSlots(),
    originalImagesExact: entries.every(
      (entry) =>
        JSON.stringify(entry.value.imageCandidate) === entry.value.original,
    ),
    imageSources: [...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map(
      (m) => m[1],
    ),
  };
  return row;
}
beforeEach(() => {
  h.active = null;
  h.instances = [];
  h.decodeSources = [];
  h.created = 0;
  h.hold = false;
  h.invoke.mockReset();
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal(
    "Image",
    class extends TestImageDecoder {
      constructor() {
        super();
        h.created++;
      }
      override decode() {
        h.decodeSources.push(this.src);
        return h.hold
          ? new Promise<void>((resolve) => h.finishes.push(resolve))
          : Promise.resolve();
      }
    },
  );
});
afterEach(async () => {
  for (const instance of h.instances)
    if (!instance.unmounted) cleanup(instance);
  for (const finish of h.finishes.splice(0)) finish();
  await settle();
  for (const lease of held.splice(0)) lease.release();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps a closed historical image free of validation and sources even with four actual leases held", () => {
  fill();
  const image = owner();
  image.render();
  const row = observe("closed-control", [image]);
  expect(row.images).toBe(0);
  expect(row.decodeCalls).toBe(0);
  expect(row.createdImages).toBe(0);
  expect(row.originalImagesExact).toBe(true);
});
it("preserves a normal explicitly opened exact image and removes the display on explicit close", async () => {
  const image = owner();
  image.open();
  await settle();
  const open = observe("normal-open-control", [image]);
  expect(open.images).toBe(1);
  expect(open.sourceExact).toBe(true);
  expect(open.decodeCalls).toBe(1);
  expect(open.originalImagesExact).toBe(true);
  expect(open.freeSlots).toBe(3);
  expect(h.invoke).not.toHaveBeenCalled();
  image.close();
  const closed = observe("normal-close-control", [image]);
  expect(closed.images).toBe(0);
  expect(closed.freeSlots).toBe(4);
});
it("rejects malformed original image data before the controlled decoder and keeps feedback", async () => {
  const image = owner(
    Object.freeze({ ...candidate(), data: btoa("not a bitmap") }),
  );
  image.open();
  await settle();
  const row = observe("malformed-control", [image]);
  expect(row.images).toBe(0);
  expect(row.decodeCalls).toBe(0);
  expect(row.originalImagesExact).toBe(true);
  expect(image.value.html).toContain('role="alert"');
  expect(row.freeSlots).toBe(4);
  expect(image.value.html).toContain("<details");
});
it("does not start image validation or assign a fifth source while the common real pool is full", async () => {
  fill();
  const image = owner();
  image.open();
  await settle();
  const row = observe("full-pool-history", [image]);
  expect(row.freeSlots).toBe(0);
  expect(row.originalImagesExact).toBe(true);
  expect(row.decodeCalls).toBe(0);
  expect(row.createdImages).toBe(0);
  expect(row.images).toBe(0);
});
it("bounds five independently opened history-image owners by the real four-instance message budget", async () => {
  const owners = Array.from({ length: 5 }, (_, at) => owner(candidate(at)));
  for (const image of owners) {
    image.open();
    await settle();
    image.render();
  }
  const row = observe("five-history-owners", owners);
  expect(row.originalImagesExact).toBe(true);
  expect(row.images).toBe(4);
  expect(row.decodeCalls).toBe(4);
});
it("retires a validated historical source on hidden ancestry and does not reopen it on return", async () => {
  const image = owner();
  image.open();
  await settle();
  const before = observe("visible-before-hide", [image]);
  image.visible(false);
  const hidden = observe("hidden-after-ready", [image]);
  image.visible(true);
  const returned = observe("returned-after-hide", [image]);
  expect(before.images).toBe(1);
  expect(hidden.images).toBe(0);
  expect(returned.images).toBe(0);
  expect(returned.originalImagesExact).toBe(true);
});
it("does not adopt a validation that completes after the historical transcript becomes hidden", async () => {
  h.hold = true;
  const image = owner();
  image.open();
  await settle();
  const pending = observe("pending-before-hide", [image]);
  image.visible(false);
  for (const finish of h.finishes.splice(0)) finish();
  await settle();
  const hidden = observe("hidden-after-late-validation", [image]);
  image.visible(true);
  const returned = observe("returned-after-late-validation", [image]);
  expect(pending.decodeCalls).toBe(1);
  expect(pending.images).toBe(0);
  expect(hidden.images).toBe(0);
  expect(returned.images).toBe(0);
  expect(returned.originalImagesExact).toBe(true);
});
it("honors the real closed-disclosure media context after a historical image was opened", async () => {
  const image = owner(candidate(), true);
  image.fold(true);
  image.open();
  await settle();
  const before = observe("disclosure-before-close", [image]);
  image.fold(false);
  const closed = observe("disclosure-after-close", [image]);
  expect(before.images).toBe(1);
  expect(closed.images).toBe(0);
  expect(closed.originalImagesExact).toBe(true);
});

it("keeps current user text literal and historical images unopened without any decoding or IPC", () => {
  const root = hooks();
  h.instances.push(root);
  h.active = root;
  const current = renderToStaticMarkup(
    <UserMessageContent text={original} historical={false} />,
  );
  expect(current).toContain("[@image]");
  expect(current).not.toContain("<details");
  h.active = hooks();
  h.instances.push(h.active);
  const historical = renderToStaticMarkup(
    <UserMessageContent text={original} historical />,
  );
  expect(historical).toContain("Before ");
  expect(historical).toContain(" after");
  expect(historical).toContain("历史图片");
  expect(historical).not.toContain("data:image");
  expect(historical).not.toContain("<img");
  expect(h.decodeSources).toHaveLength(0);
  expect(h.created).toBe(0);
  expect(h.invoke).not.toHaveBeenCalled();
  h.active = null;
});
it("does not duplicate a pending exact validation on a repeated native open event", async () => {
  h.hold = true;
  const image = owner();
  image.open();
  await settle();
  image.open();
  await settle();
  expect(h.decodeSources).toEqual([
    `data:image/png;base64,${image.value.imageCandidate.data}`,
  ]);
  expect(observe("pending", [image]).images).toBe(0);
  h.finishes.shift()!();
  await settle();
  const open = observe("exact-ready", [image]);
  expect(open.imageSources).toEqual([
    `data:image/png;base64,${image.value.imageCandidate.data}`,
  ]);
  image.close();
  expect(observe("exact-closed", [image]).images).toBe(0);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("ignores an old validation after the same display position changes image identity", async () => {
  h.hold = true;
  const image = owner();
  image.open();
  await settle();
  expect(h.decodeSources).toHaveLength(1);
  const next = Object.freeze({
    ...image.value.imageCandidate,
    mimeType: "image/jpeg" as const,
  });
  image.change(next);
  expect(observe("identity-changed", [image]).images).toBe(0);
  expect(freeSlots()).toBe(4);
  h.finishes.shift()!();
  await settle();
  expect(observe("old-validation-returned", [image]).images).toBe(0);
  image.open();
  await settle();
  image.render();
  expect(image.value.html).toContain('role="alert"');
  expect(h.decodeSources).toHaveLength(1);
  expect(observe("mismatched-mime", [image]).images).toBe(0);
  expect(image.value.imageCandidate).toEqual(next);
});
it("retains the shared two decoder slots after timeout and never applies a closed check", async () => {
  vi.useFakeTimers();
  h.hold = true;
  const image = owner();
  for (let at = 0; at < 3; at++) {
    image.open();
    await settle();
    image.close();
  }
  expect(h.decodeSources).toHaveLength(2);
  expect(freeSlots()).toBe(4);
  await vi.advanceTimersByTimeAsync(15_000);
  image.open();
  await settle();
  expect(h.decodeSources).toHaveLength(2);
  expect(observe("timed-out-still-unsettled", [image]).images).toBe(0);
  expect(image.value.html).toContain('role="alert"');
  for (const finish of h.finishes.splice(0)) finish();
  await settle();
  expect(observe("late-settled", [image]).images).toBe(0);
});
it("keeps attachment keyboard handling local without preventing native expansion", () => {
  const image = owner();
  image.render();
  for (const key of ["Enter", "Backspace", " ", "Escape"]) {
    const stopPropagation = vi.fn(),
      preventDefault = vi.fn();
    image.value.keyDown({ key, stopPropagation, preventDefault });
    expect(stopPropagation).toHaveBeenCalledTimes(
      key === "Enter" || key === "Backspace" ? 1 : 0,
    );
    expect(preventDefault).not.toHaveBeenCalled();
  }
});
it("retires an exact ready source on unmount and ignores its stale failure callback", async () => {
  const first = owner();
  first.open();
  await settle();
  first.render();
  const media = first.value.media,
    node = media.node,
    onError = media.image.onError;
  expect(node.getAttribute("src")).toBe(
    `data:image/png;base64,${first.value.imageCandidate.data}`,
  );
  expect(freeSlots()).toBe(3);
  first.unmount();
  expect(node.getAttribute("src")).toBeNull();
  expect(freeSlots()).toBe(4);
  const second = owner();
  second.open();
  await settle();
  second.render();
  node.isConnected = true;
  onError({ currentTarget: node });
  expect(observe("new-owner-after-stale-error", [second]).images).toBe(1);
  expect(freeSlots()).toBe(3);
});
it("releases only its pending unmounted owner and ignores a late validation", async () => {
  h.hold = true;
  const first = owner();
  first.open();
  await settle();
  expect(freeSlots()).toBe(3);
  first.unmount();
  expect(freeSlots()).toBe(4);
  const second = owner();
  second.open();
  await settle();
  expect(freeSlots()).toBe(3);
  h.finishes.shift()!();
  await settle();
  expect(observe("unmounted-late-return", [second]).images).toBe(0);
  expect(freeSlots()).toBe(3);
  h.finishes.shift()!();
  await settle();
  expect(observe("remaining-own-return", [second]).images).toBe(1);
  expect(freeSlots()).toBe(3);
});
it("retires a failed real renderer node before releasing only its owner, with explicit retry and stale-handler isolation", async () => {
  const first = owner(),
    second = owner();
  first.open();
  await settle();
  first.render();
  second.open();
  await settle();
  second.render();
  const old = first.value.media,
    node = old.node,
    props = old.image;
  expect(freeSlots()).toBe(2);
  const remove = node.removeAttribute.getMockImplementation()!;
  node.removeAttribute.mockImplementation((name: string) => {
    expect(name).toBe("src");
    expect(freeSlots()).toBe(2);
    remove(name);
  });
  props.onError({ currentTarget: node });
  expect(node.getAttribute("src")).toBeNull();
  expect(freeSlots()).toBe(3);
  expect(observe("own-error", [first, second]).images).toBe(1);
  expect(first.value.html).toContain('role="alert"');
  expect(h.decodeSources).toHaveLength(2);
  first.render();
  expect(h.decodeSources).toHaveLength(2);
  first.retry();
  await settle();
  first.render();
  expect(h.decodeSources).toHaveLength(3);
  expect(freeSlots()).toBe(2);
  const replacement = first.value.media.node;
  node.isConnected = true;
  props.onError({ currentTarget: node });
  props.ref(node);
  expect(node.getAttribute("src")).toBeNull();
  expect(replacement.getAttribute("src")).toBe(
    `data:image/png;base64,${first.value.imageCandidate.data}`,
  );
  expect(observe("retried-own-source", [first, second]).images).toBe(2);
  expect(freeSlots()).toBe(2);
});
it("requires explicit retry after another owner frees the real shared pool", async () => {
  fill();
  const image = owner();
  image.open();
  await settle();
  expect(observe("budget-refused", [image]).images).toBe(0);
  expect(h.decodeSources).toHaveLength(0);
  for (const lease of held.splice(0)) lease.release();
  image.render();
  expect(freeSlots()).toBe(4);
  expect(h.decodeSources).toHaveLength(0);
  image.retry();
  await settle();
  expect(observe("budget-explicit-retry", [image]).images).toBe(1);
  expect(freeSlots()).toBe(3);
  expect(h.decodeSources).toHaveLength(1);
});
it("keeps the original 8 MiB image limit before allocating or decoding oversized historical data", async () => {
  const image = owner(
    Object.freeze({
      ...candidate(),
      data: "A".repeat(4 * Math.ceil((8 * 1024 * 1024) / 3) + 4),
    }),
  );
  image.open();
  await settle();
  expect(observe("oversized-refused", [image]).images).toBe(0);
  expect(h.created).toBe(0);
  expect(h.decodeSources).toHaveLength(0);
  expect(freeSlots()).toBe(4);
  expect(image.value.html).toContain('role="alert"');
});
