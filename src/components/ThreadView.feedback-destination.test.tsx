import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  browserPending: false,
  slots: [] as {
    value?: unknown;
    deps?: unknown[];
    cleanup?: () => void;
    setup?: () => void | (() => void);
  }[],
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
      (next: unknown) =>
        (slot.value = typeof next === "function" ? next(slot.value) : next),
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  // Direct-call reading tests run outside the search provider.
  useContext: () => false,
  useMemo: (read: () => unknown) => read(),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.setup = effect;
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
}));
// These tests invoke ThreadView with a minimal hook harness; browser permissions
// have their own controller/component tests and are absent from these scenarios.
vi.mock("../runtime/browser_sharing", async (original) => {
  const actual = await original<typeof import("../runtime/browser_sharing")>();
  const noop = async () => {};
  const empty: import("../runtime/browser_sharing").BrowserSharingModel = {
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    queryState: "no_session",
    refresh: noop,
    allow: noop,
    stop: noop,
    respond: noop,
  };
  return {
    ...actual,
    useBrowserSharing: () => ({
      ...empty,
      pendingRequest: h.browserPending
        ? {
            requestId: "read:synthetic",
            taskKey: "reading",
            label: "page",
            url: "https://example.org/",
            pageRevision: 1,
            phase: "awaiting_permission" as const,
          }
        : null,
    }),
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));

import { ThreadView } from "./ThreadView";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
import { ArtifactPane } from "./ArtifactPane";
import { freshThreadState } from "../runtime/session_projection";
import {
  composerDrafts,
  fileFeedbackDrafts,
  newConversationChoice,
  draftPersistence,
  type SavedFileFeedback,
  type FileFeedbackDestination,
} from "../runtime/drafts";
import { fileFeedbackText } from "../runtime/feedback_strings";
type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const all: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      all.push(child, ...nodes(child.props.children as ReactNode));
  });
  return all;
}
let thread = freshThreadState("routing-draft", "agent", "/work", "native"),
  prepared = true,
  preparedCurrent = true;
function render(active = true) {
  h.cursor = 0;
  const tree = nodes(
    ThreadView({
      thread,
      active,
      agents: [],
      onGoSettings: () => {},
      onOpened: () => {},
      ...(prepared
        ? {
            draftComposerRef: () => {},
            preparedComposerIsCurrent: () => preparedCurrent,
          }
        : {}),
    }),
  );
  for (const effect of h.effects.splice(0)) effect();
  return tree;
}
const route = (active = true) =>
  render(active).find((node) => node.type === FileFeedbackDrafts)!.props
    .feedbackDestination as FileFeedbackDestination;
const anchors: Record<string, SavedFileFeedback["anchor"]> = {
  text: {
    kind: "text-range",
    byteStart: 0,
    byteEnd: 5,
    startLine: 1,
    endLine: 1,
  },
  pdf: { kind: "pdf-page", page: 1, pageCount: 2 },
  image: {
    kind: "image-area",
    space: "display-oriented-v1",
    left: 0,
    top: 0,
    right: 1,
    bottom: 1,
  },
  xlsx: {
    kind: "xlsx-range",
    sheetId: "sheet",
    sheetName: "Sheet1",
    fromRow: 1,
    toRow: 1,
    fromColumn: 1,
    toColumn: 1,
  },
  docx: {
    kind: "docx-block",
    part: "word/document.xml",
    elementPath: [0],
    blockKind: "paragraph",
  },
  pptx: {
    kind: "pptx-slide",
    part: "ppt/slides/slide3.xml",
    previewSlide: 2,
    previewSlideCount: 2,
  },
  diff: undefined,
};
function opinion(format = "pptx") {
  const path = `/work/report.${format}`;
  const entry: SavedFileFeedback = {
    path,
    text: `  ${format} opinion\n`,
    selection: null,
    scope: "file",
    contentId: `disk:${JSON.stringify([path, "v1", "a".repeat(64)])}`,
    ...(anchors[format] ? { anchor: anchors[format] } : {}),
  };
  fileFeedbackDrafts.update(thread.key, path, entry);
  const key = Object.keys(fileFeedbackDrafts.entries(thread.key)).find(
    (key) => fileFeedbackDrafts.entries(thread.key)[key].path === path,
  )!;
  return { key, entry };
}
function take(key: string, text: string, destination: unknown) {
  return (fileFeedbackDrafts.take as (...args: unknown[]) => boolean)(
    thread.key,
    key,
    text,
    destination,
  );
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.cursor = 0;
  thread = freshThreadState("routing-draft", "agent", "/work", "native");
  thread.identity = "draft";
  prepared = true;
  preparedCurrent = true;
  composerDrafts.clear("new");
  composerDrafts.clear(`session:${thread.key}`);
  for (const entry of Object.values(fileFeedbackDrafts.entries(thread.key)))
    fileFeedbackDrafts.clear(thread.key, entry.path);
  Object.assign(newConversationChoice, {
    agentId: "agent",
    cwd: "/work",
    service: null,
    config: {},
    reviewRequired: false,
  });
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.unstubAllGlobals();
});
it.each(Object.keys(anchors))(
  "prepared visible input receives exact %s opinion once while hidden session and unrelated drafts remain unchanged",
  (format) => {
    const visible = {
      text: "visible prefix",
      attachments: [
        {
          id: "keep",
          kind: "file" as const,
          name: "keep.md",
          uri: "file:///keep.md",
        },
      ],
    };
    composerDrafts.update("new", () => visible);
    const old = { text: "old unrelated", attachments: [], sendPending: true };
    composerDrafts.update("session:unrelated", () => old);
    const destination = route();
    const { key, entry } = opinion(format);
    const text = fileFeedbackText(entry);
    expect(take(key, text, destination)).toBe(true);
    expect(composerDrafts.read("new")).toEqual({
      ...visible,
      text: `visible prefix\n\n${text}`,
    });
    expect(composerDrafts.read(`session:${thread.key}`).text).toBe("");
    expect(composerDrafts.read("session:unrelated")).toEqual(old);
    expect(take(key, text, destination)).toBe(false);
    expect(fileFeedbackDrafts.entries(thread.key)).toEqual({});
  },
);
it("passes the same visible destination to both historical opinions and the common artifact pane", () => {
  const tree = render();
  const destination = tree.find((node) => node.type === FileFeedbackDrafts)!
    .props.feedbackDestination;
  expect(destination).toBeDefined();
  expect(
    tree.find((node) => node.type === ArtifactPane)!.props.feedbackDestination,
  ).toBe(destination);
});

it("established conversations keep their exact session input and preserve queue/pending fields", () => {
  prepared = false;
  thread.identity = "established";
  const original = {
    text: "session prefix",
    attachments: [],
    sendPending: true,
    queueEdit: {
      index: 0,
      original: [{ type: "text" as const, text: "queued" }],
    },
  };
  composerDrafts.update(`session:${thread.key}`, () => original);
  composerDrafts.update("new", () => ({
    text: "unrelated new",
    attachments: [],
  }));
  const destination = route();
  const { key, entry } = opinion();
  expect(destination.draftKey).toBe(`session:${thread.key}`);
  expect(take(key, fileFeedbackText(entry), destination)).toBe(true);
  expect(composerDrafts.read(`session:${thread.key}`)).toEqual({
    ...original,
    text: expect.stringContaining(entry.text),
  });
  expect(composerDrafts.read("new").text).toBe("unrelated new");
});
it.each([
  "hide-return",
  "route-return",
  "generation",
  "choice-return",
  "cwd",
  "prepared-owner",
])(
  "a retired %s destination preserves the opinion and never joins a later visible draft",
  (kind) => {
    const destination = route();
    const { key, entry } = opinion();
    if (kind === "hide-return") {
      render(false);
      render(true);
    }
    if (kind === "route-return") {
      prepared = false;
      render();
      prepared = true;
      render();
    }
    if (kind === "generation") composerDrafts.clear("new");
    if (kind === "choice-return") {
      newConversationChoice.agentId = "other";
      newConversationChoice.agentId = "agent";
    }
    if (kind === "prepared-owner") preparedCurrent = false;
    if (kind === "cwd") thread.cwd = "/other";
    expect(take(key, fileFeedbackText(entry), destination)).toBe(false);
    expect(fileFeedbackDrafts.entries(thread.key)[key]).toEqual(entry);
    expect(composerDrafts.read("new").text).toBe("");
    expect(composerDrafts.read(`session:${thread.key}`).text).toBe("");
  },
);
it("ordinary visible typing keeps the destination current without replacing attachments or targeting a hidden input", () => {
  const destination = route();
  composerDrafts.update("new", () => ({
    text: "typed later",
    attachments: [{ id: "a", kind: "file", name: "a.md", uri: "file:///a.md" }],
  }));
  const { key, entry } = opinion();
  expect(take(key, fileFeedbackText(entry), destination)).toBe(true);
  expect(composerDrafts.read("new").text).toBe(
    `typed later\n\n${fileFeedbackText(entry)}`,
  );
  expect(composerDrafts.read("new").attachments).toHaveLength(1);
});
it.each(["wrong-source", "wrong-target"])(
  "the common take refuses a %s destination without consuming the opinion",
  (kind) => {
    const valid = route();
    const { key, entry } = opinion();
    const invalid = {
      ...valid,
      ...(kind === "wrong-source"
        ? { threadKey: "other" }
        : { draftKey: "session:other" }),
    };
    expect(take(key, fileFeedbackText(entry), invalid)).toBe(false);
    expect(fileFeedbackDrafts.entries(thread.key)[key]).toEqual(entry);
    expect(composerDrafts.read("session:other").text).toBe("");
  },
);
it("StrictMode effect replay retires the old route while a subsequent render issues a usable fresh route", () => {
  const old = route();
  for (const slot of h.slots)
    if (slot.setup) {
      slot.cleanup?.();
      slot.cleanup = slot.setup() || undefined;
    }
  const fresh = route();
  const { key, entry } = opinion();
  expect(take(key, fileFeedbackText(entry), old)).toBe(false);
  expect(take(key, fileFeedbackText(entry), fresh)).toBe(true);
});
it.each(["pending", "storage-lock", "first-send"])(
  "temporary %s refusal preserves opinions and allows the same current visible route after recovery",
  (kind) => {
    composerDrafts.update("new", () => ({ text: "prefix", attachments: [] }));
    const destination = route();
    const { key, entry } = opinion();
    if (kind === "pending")
      composerDrafts.update("new", (d) => ({ ...d, sendPending: true }));
    if (kind === "storage-lock") draftPersistence.lockInteraction(true);
    if (kind === "first-send") thread.submitting = true;
    expect(take(key, fileFeedbackText(entry), destination)).toBe(false);
    expect(fileFeedbackDrafts.entries(thread.key)[key]).toEqual(entry);
    if (kind === "pending")
      composerDrafts.update("new", (d) => ({ ...d, sendPending: false }));
    if (kind === "storage-lock") draftPersistence.lockInteraction(false);
    if (kind === "first-send") thread.submitting = false;
    expect(take(key, fileFeedbackText(entry), destination)).toBe(true);
    expect(composerDrafts.read("new").text).toBe(
      `prefix\n\n${fileFeedbackText(entry)}`,
    );
  },
);
it("an old prepared thread cannot rebase its visible destination onto a different actual preparation", () => {
  const stale = route();
  newConversationChoice.cwd = "/new-place";
  preparedCurrent = false;
  const inFlight = route();
  const { key, entry } = opinion();
  expect(take(key, fileFeedbackText(entry), stale)).toBe(false);
  expect(take(key, fileFeedbackText(entry), inFlight)).toBe(false);
  expect(fileFeedbackDrafts.entries(thread.key)[key]).toEqual(entry);
});
