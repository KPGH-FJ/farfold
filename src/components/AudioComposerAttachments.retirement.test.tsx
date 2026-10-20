import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { audioCapture } from "../runtime/audio_input.test-support";
import { AUDIO_INPUT as A } from "../runtime/audio_input";
import { DOCUMENT_INPUT_STRINGS as D } from "../runtime/document_input_strings";
import type { DraftAttachment } from "../runtime/drafts";

// Only the existing hook scheduling surface and Tauri IPC delivery are controlled.
// readAudioInput/readDocumentInput, their targets, storage, and validation are real.
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  saved: vi.fn(),
  nativePending: 0,
  nativeCalls: [] as string[],
  writes: [] as Record<string, unknown>[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const i = h.cursor++;
    const s = h.slots[i] ?? (h.slots[i] = { value: initial });
    return [
      s.value,
      (v: unknown) => {
        s.value = v;
      },
    ];
  },
  useRef(current: unknown) {
    const i = h.cursor++;
    return (h.slots[i] ?? (h.slots[i] = { value: { current } })).value;
  },
  useEffect(setup: () => void | (() => void), deps: unknown[]) {
    const i = h.cursor++,
      old = h.slots[i];
    if (!old || deps.some((v, at) => !Object.is(v, old.deps?.[at]))) {
      const next = (h.slots[i] = { deps, cleanup: old?.cleanup });
      h.effects.push(() => {
        old?.cleanup?.();
        next.cleanup = setup() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
type Node = ReactElement<Record<string, unknown>>;
function flatten(tree: ReactNode): Node[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...flatten(child.props.children as ReactNode)]
      : [],
  );
}
function text(tree: ReactNode): string {
  return Children.toArray(tree)
    .map((child) =>
      isValidElement<{ children: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
}
let d: typeof import("../runtime/drafts");
let audio: typeof import("./useAudioComposerAttachments").useAudioComposerAttachments;
let documents: typeof import("./DocumentComposerAttachments").DocumentComposerAttachments;
let finishNative: (value: unknown) => void;
let rejectNative: (reason: unknown) => void;
let nativeDelivery: Promise<unknown>;
let settleReads: () => Promise<void>;
function nextNativeDelivery() {
  nativeDelivery = new Promise<unknown>((resolve, reject) => {
    finishNative = resolve;
    rejectNative = reject;
  });
}
let mode: "audio" | "document" = "audio";
let expectedFinal: { text: string; attachments: DraftAttachment[] } | null =
  null;
function selected(): DraftAttachment {
  return {
    id: "owned-source",
    kind: "file",
    name: "sample.wav",
    uri: "file:///chosen/sample.wav",
    mimeType: "audio/wav",
  };
}
function renderAudio() {
  h.cursor = 0;
  const value = audio({
    draftKey: "new",
    context: "owned-context",
    enabled: true,
    items: d.composerDrafts.read("new").attachments,
    onSaved: h.saved,
  });
  for (const effect of h.effects.splice(0)) effect();
  return value;
}
function renderDocument() {
  h.cursor = 0;
  const value = documents({
    draftKey: "new",
    context: "owned-context",
    enabled: true,
    items: d.composerDrafts.read("new").attachments,
    onRemove: () => {},
  });
  for (const effect of h.effects.splice(0)) effect();
  return flatten(value);
}
function beginAudio() {
  const value = renderAudio();
  const button = flatten(
    value.action(d.composerDrafts.read("new").attachments[0]),
  ).find(
    (n) =>
      n.type === "button" && text(n.props.children as ReactNode) === A.read,
  )!;
  expect(button.props.disabled).toBe(false);
  (button.props.onClick as () => void)();
  renderAudio();
}
function closeAudio() {
  const button = flatten(renderAudio().dialog).find(
    (n) =>
      n.type === "button" && text(n.props.children as ReactNode) === A.cancel,
  );
  if (button) (button.props.onClick as () => void)();
}
function closeDocument() {
  const node = renderDocument().find(
    (n) =>
      typeof n.type === "function" && n.type.name === "DocumentInputReview",
  );
  if (node) (node.props.onClose as () => void)();
}
async function microtasks() {
  for (let at = 0; at < 64; at++) await Promise.resolve();
}
async function inspectSave(_label: string, wanted: boolean) {
  let flushed = false;
  const saving = d.draftPersistence.flush().then(() => {
    flushed = true;
  });
  await microtasks();
  expect(h.nativePending).toBe(1);
  expect(flushed).toBe(wanted);
  if (wanted) {
    const saved = h.writes.at(-1) as
      { composers?: { new?: { text?: unknown } } } | undefined;
    expect(saved?.composers?.new?.text).toBe(d.composerDrafts.read("new").text);
  } else expect(h.writes).toHaveLength(0);
  // Do not await the deliberately pending positive-control flush here.
  // afterEach releases the same original delivery and awaits storage cleanup.
  void saving;
}
beforeEach(async () => {
  vi.resetModules();
  expectedFinal = null;
  h.saved.mockReset();
  vi.stubGlobal("crypto", webcrypto);
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.writes = [];
  h.nativeCalls = [];
  h.nativePending = 0;
  mode = "audio";
  nextNativeDelivery();
  h.invoke
    .mockReset()
    .mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "settings_get") return Promise.resolve(null);
      if (command === "settings_set") {
        h.writes.push(structuredClone(args.value) as Record<string, unknown>);
        return Promise.resolve(null);
      }
      if (
        command === "draft_attachment_audio" ||
        command === "file_delivery_inspect_selected"
      ) {
        h.nativeCalls.push(command);
        h.nativePending++;
        return nativeDelivery.finally(() => {
          h.nativePending--;
        });
      }
      throw new Error("unexpected IPC " + command);
    });
  d = await import("../runtime/drafts");
  const audioInput = await import("../runtime/audio_input");
  const documentInput = await import("../runtime/document_input");
  // Default spies preserve each real implementation and its returned promise.
  const reads = [
    vi.spyOn(audioInput, "readAudioInput"),
    vi.spyOn(documentInput, "readDocumentInput"),
  ];
  settleReads = async () => {
    await Promise.allSettled(
      reads.flatMap((read) =>
        read.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      ),
    );
  };
  audio = (await import("./useAudioComposerAttachments"))
    .useAudioComposerAttachments;
  documents = (await import("./DocumentComposerAttachments"))
    .DocumentComposerAttachments;
  await d.draftPersistence.load();
  d.composerDrafts.update("new", () => ({
    text: "OWNED_BASE",
    attachments: [selected()],
  }));
  await d.draftPersistence.flush();
  renderAudio();
  h.writes = [];
});
afterEach(async () => {
  if (mode === "audio") {
    closeAudio();
    finishNative(audioCapture());
  } else {
    closeDocument();
    rejectNative({ code: "unreadable" });
  }
  await settleReads();
  await d.draftPersistence.flush();
  for (const slot of h.slots) slot.cleanup?.();
  await microtasks();
  expect(h.nativePending).toBe(0);
  expect(d.draftPersistence.snapshot().error).toBeNull();
  if (expectedFinal) {
    expect(d.composerDrafts.read("new").text).toBe(expectedFinal.text);
    const actual = d.composerDrafts.read("new").attachments;
    expect(actual).toHaveLength(expectedFinal.attachments.length);
    for (let at = 0; at < actual.length; at++)
      expect(actual[at]).toBe(expectedFinal.attachments[at]);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retained audio preparation still protects save before actual native delivery", async () => {
  beginAudio();
  expect(d.composerDrafts.read("new").attachments[0].loading).toBe(true);
  await inspectSave("audio-retained", false);
});
it("explicit audio cancel retires the exact target and permits new text save before native delivery", async () => {
  const original = d.composerDrafts.read("new").attachments[0];
  beginAudio();
  closeAudio();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(original);
  expect(original.loading).not.toBe(true);
  d.composerDrafts.update("new", (v) => ({ ...v, text: "OWNED_AFTER_CANCEL" }));
  expectedFinal = { text: "OWNED_AFTER_CANCEL", attachments: [original] };
  await inspectSave("audio-cancelled", true);
});
it("audio source withdrawal permits new text save without waiting for the retired native delivery", async () => {
  beginAudio();
  d.composerDrafts.update("new", (v) => ({
    ...v,
    text: "OWNED_AFTER_REMOVE",
    attachments: [],
  }));
  renderAudio();
  expectedFinal = { text: "OWNED_AFTER_REMOVE", attachments: [] };
  await inspectSave("audio-withdrawn", true);
});
it("actual document cancellation releases only its wait while native inspect delivery remains pending", async () => {
  mode = "document";
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  const attachment: DraftAttachment = {
    id: "owned-docx",
    kind: "file",
    name: "sample.docx",
    uri: "file:///chosen/sample.docx",
  };
  d.composerDrafts.update("new", () => ({
    text: "OWNED_DOCX",
    attachments: [attachment],
  }));
  await d.draftPersistence.flush();
  const node = renderDocument().find(
    (n) =>
      typeof n.type === "function" && n.type.name === "ComposerAttachments",
  )!;
  const button = flatten(
    (node.props.action as (item: DraftAttachment) => ReactNode)(attachment),
  ).find(
    (n) =>
      n.type === "button" && text(n.props.children as ReactNode) === D.read,
  )!;
  (button.props.onClick as () => void)();
  expect(h.nativeCalls).toEqual(["file_delivery_inspect_selected"]);
  closeDocument();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(attachment);
  d.composerDrafts.update("new", (v) => ({
    ...v,
    text: "OWNED_DOCX_AFTER_CANCEL",
  }));
  expectedFinal = {
    text: "OWNED_DOCX_AFTER_CANCEL",
    attachments: [attachment],
  };
  await inspectSave("docx-actual-cancelled", true);
});

it("cancel during actual confirmation reread saves new text and never applies a valid late reply or saved notice", async () => {
  const original = d.composerDrafts.read("new").attachments[0];
  beginAudio();
  finishNative(audioCapture());
  const confirmButton = () =>
    flatten(renderAudio().dialog).find(
      (n) =>
        n.type === "button" &&
        text(n.props.children as ReactNode) === A.confirm,
    );
  await vi.waitFor(() => expect(confirmButton()?.props.disabled).toBe(false));
  expect(h.nativePending).toBe(0);
  nextNativeDelivery();
  (confirmButton()!.props.onClick as () => void)();
  await vi.waitFor(() =>
    expect(h.nativeCalls).toEqual([
      "draft_attachment_audio",
      "draft_attachment_audio",
    ]),
  );
  closeAudio();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(original);
  d.composerDrafts.update("new", (v) => ({
    ...v,
    text: "OWNED_AFTER_CONFIRM_CANCEL",
  }));
  expectedFinal = {
    text: "OWNED_AFTER_CONFIRM_CANCEL",
    attachments: [original],
  };
  await inspectSave("audio-confirm-cancelled", true);
  expect(h.saved).not.toHaveBeenCalled();

  // Observe the genuine SHA promise; do not fake its bytes or completion.
  // Waiting for it and its synchronous continuations makes the late success
  // assertion stronger than merely observing the native IPC reply resolve.
  const digests: Promise<ArrayBuffer>[] = [];
  const originalDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  const observer = vi
    .spyOn(webcrypto.subtle, "digest")
    .mockImplementation((algorithm, data) => {
      const task = originalDigest(algorithm, data);
      digests.push(task);
      return task;
    });
  try {
    finishNative(audioCapture());
    await vi.waitFor(() => expect(digests).toHaveLength(1));
    await Promise.all(digests);
    await microtasks();
    await d.draftPersistence.flush();
    expect(h.nativePending).toBe(0);
    expect(d.composerDrafts.read("new").text).toBe(
      "OWNED_AFTER_CONFIRM_CANCEL",
    );
    expect(d.composerDrafts.read("new").attachments[0]).toBe(original);
    expect(original.kind).toBe("file");
    expect(h.saved).not.toHaveBeenCalled();
  } finally {
    observer.mockRestore();
  }
});
