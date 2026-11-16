import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovedDocumentText } from "../runtime/document_input_types";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  failing: false,
  hold: null as null | Promise<void>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const i = h.cursor++;
    const state = h.slots[i] ?? (h.slots[i] = { value: initial });
    return [
      state.value,
      (value: unknown) => {
        state.value = typeof value === "function" ? value(state.value) : value;
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
    if (!old || deps.some((value, n) => !Object.is(value, old.deps?.[n]))) {
      const next = (h.slots[i] = { deps, cleanup: old?.cleanup });
      h.effects.push(() => {
        old?.cleanup?.();
        next.cleanup = setup() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
let d: typeof import("../runtime/drafts");
let storage: typeof import("../runtime/draft_storage");
let hook: typeof import("./useComposerSourceError").useComposerSourceError;
let key = "new",
  context = "same-choice";
function render() {
  h.cursor = 0;
  const value = hook(key, context, d.composerDrafts.read(key).attachments);
  for (const effect of h.effects.splice(0)) effect();
  return value;
}
async function writeFailure() {
  h.failing = true;
  d.composerDrafts.update(key, () => ({
    text: "UNSAVED_BODY",
    attachments: [],
  }));
  let failure: unknown;
  try {
    await d.draftPersistence.flush();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(storage.DraftSaveError);
  render().setSendFailure(failure);
  expect(render().sendError?.message).toBe(storage.DRAFT_STRINGS.saveFailed);
  return failure;
}
beforeEach(async () => {
  vi.resetModules();
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.failing = false;
  h.hold = null;
  key = "new";
  context = "same-choice";
  h.invoke.mockReset().mockImplementation(async (name) => {
    if (name === "settings_get") return null;
    if (name !== "settings_set") throw new Error(`Unexpected ${name}`);
    if (h.failing) throw new Error("controlled disk failure");
    if (h.hold) await h.hold;
  });
  d = await import("../runtime/drafts");
  storage = await import("../runtime/draft_storage");
  hook = (await import("./useComposerSourceError")).useComposerSourceError;
  await d.draftPersistence.load();
  d.composerDrafts.update(key, () => ({ text: "ORIGINAL", attachments: [] }));
  await d.draftPersistence.flush();
  render();
});
afterEach(async () => {
  for (const slot of h.slots) slot.cleanup?.();
  h.failing = false;
  h.hold = null;
  await d.draftPersistence.flush();
});
it("clears a typed failed-save send notice only after actual retry saves that same input, without dispatch", async () => {
  await writeFailure();
  const input = d.composerDrafts.read(key);
  h.failing = false;
  await d.draftPersistence.flush();
  expect(render().sendError).toBeNull();
  expect(d.composerDrafts.read(key)).toBe(input);
  expect(h.invoke.mock.calls.every(([name]) => name !== "session_prompt")).toBe(
    true,
  );
});
it("does not treat error=null at retry start as saved", async () => {
  await writeFailure();
  let finish!: () => void;
  h.hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.failing = false;
  const retry = d.draftPersistence.flush();
  await vi.waitFor(() =>
    expect(d.draftPersistence.snapshot().saving).toBe(true),
  );
  expect(d.draftPersistence.snapshot().error).toBeNull();
  expect(render().sendError?.message).toBe(storage.DRAFT_STRINGS.saveFailed);
  finish();
  await retry;
  expect(render().sendError).toBeNull();
});
it("does not clear a repeated failed save", async () => {
  await writeFailure();
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(render().sendError?.message).toBe(storage.DRAFT_STRINGS.saveFailed);
});
it("keeps a plain Agent error with the identical visible message", async () => {
  await writeFailure();
  render().setSendFailure(new Error(storage.DRAFT_STRINGS.saveFailed));
  h.failing = false;
  await d.draftPersistence.flush();
  expect(render().sendError?.message).toBe(storage.DRAFT_STRINGS.saveFailed);
});
it("retiring a save notice for a later ordinary notice prevents late clearing", async () => {
  await writeFailure();
  render().setSendError({ message: "普通 Agent 错误" });
  h.failing = false;
  await d.draftPersistence.flush();
  expect(render().sendError).toEqual({ message: "普通 Agent 错误" });
});
it("keeps image warnings independent of a send notice and rejects a late report in another draft", () => {
  const chip = { id: "owned", kind: "image" as const, name: "owned.png" };
  d.composerDrafts.update(key, (draft) => ({ ...draft, attachments: [chip] }));
  const original = render();
  original.setSendError({ message: "send notice" });
  original.reportImport("unreadable image", chip.id);
  expect(render()).toMatchObject({
    sendError: { message: "send notice" },
    imageImportMessage: "unreadable image",
  });
  key = "other";
  d.composerDrafts.update(key, (draft) => ({ ...draft, attachments: [chip] }));
  render();
  render().setSendError({ message: "other send notice" });
  original.reportImport("late image report", chip.id);
  expect(render()).toMatchObject({
    sendError: { message: "other send notice" },
    imageImportMessage: undefined,
  });
});
it("retires a missing audio source notice when its attachment is removed", async () => {
  const { audioAttachment } =
    await import("../runtime/audio_input.test-support");
  const { AudioSourceError } = await import("../runtime/audio_source_error");
  const { prepareDraftAttachments } =
    await import("../runtime/draft_attachments");
  const original = audioAttachment();
  const image = {
    id: "other-image",
    kind: "image" as const,
    name: "other.png",
  };
  const unrelatedWarning = "unrelated image warning";
  const fallback = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (name, args) => {
    if (name !== "draft_attachment_audio") return fallback(name, args);
    expect(args).toEqual({
      uri: original.uri,
      expected: original.localAudio?.file,
    });
    throw { code: "unreadable" };
  });
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [original, image],
  }));
  await d.draftPersistence.flush();

  const failure = await prepareDraftAttachments([original], true).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AudioSourceError);
  expect(failure).toMatchObject({
    code: "unreadable",
    attachmentId: original.id,
  });
  render().setSendFailure(failure);
  render().reportImport(unrelatedWarning, image.id);
  expect(render()).toMatchObject({
    sendError: { message: (failure as Error).message },
    imageImportMessage: unrelatedWarning,
  });

  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== original.id),
  }));
  expect.soft(render().sendError).toBeNull();
  expect.soft(render().imageImportMessage).toBe(unrelatedWarning);

  const replacementSource = {
    id: "new-audio",
    kind: "file" as const,
    name: original.name,
    uri: original.uri,
  };
  const applied = { ...audioAttachment(), id: replacementSource.id };
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [...draft.attachments, replacementSource],
  }));
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: draft.attachments.map((item) =>
      item === replacementSource ? applied : item,
    ),
  }));
  await d.draftPersistence.flush();
  const confirmation = {
    draftKey: key,
    attachment: replacementSource,
    applied,
  };
  render().audioSaved(confirmation);
  expect.soft(render().sendError).toBeNull();
  expect.soft(render().imageImportMessage).toBe(unrelatedWarning);
  render().setSendError({ message: "unrelated Agent notice" });
  render().audioSaved(confirmation);
  expect(render().sendError).toEqual({ message: "unrelated Agent notice" });
  expect(d.composerDrafts.read(key).text).toBe("ORIGINAL");
  expect(h.invoke.mock.calls.map(([name]) => name)).not.toContain(
    "session_prompt",
  );
});
it.each([
  "replaced-attachment-list",
  "same-object-ABA",
  "same-text-copy",
  "another-draft",
] as const)("cannot resolve the old failed input after %s", async (change) => {
  await writeFailure();
  const original = d.composerDrafts.read(key);
  if (change === "same-object-ABA") {
    d.composerDrafts.clear(key);
    d.composerDrafts.update(key, () => original);
  } else if (change === "another-draft") {
    key = "other";
    render();
    render().setSendError({ message: "别处的错误" });
  } else
    d.composerDrafts.update(key, () => ({
      ...original,
      attachments:
        change === "replaced-attachment-list"
          ? [...original.attachments]
          : original.attachments,
    }));
  h.failing = false;
  await d.draftPersistence.flush();
  expect(render().sendError?.message).toBe(
    change === "another-draft"
      ? "别处的错误"
      : storage.DRAFT_STRINGS.saveFailed,
  );
});
it("context away-and-back does not let an earlier write clear a new notice", async () => {
  await writeFailure();
  let finish!: () => void;
  h.hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.failing = false;
  const retry = d.draftPersistence.flush();
  await vi.waitFor(() =>
    expect(d.draftPersistence.snapshot().saving).toBe(true),
  );
  context = "other-choice";
  render();
  context = "same-choice";
  render();
  render().setSendError({ message: "新提示" });
  finish();
  await retry;
  expect(render().sendError).toEqual({ message: "新提示" });
});
async function documentSourceFixture() {
  const { DocumentInputError } =
    await import("../runtime/document_input_types");
  const { DocumentSourceError, documentSourceError } =
    await import("../runtime/document_source_error");
  const attachment = {
    id: "old-file",
    kind: "file" as const,
    name: "old.docx",
    uri: "file:///owned/old.docx",
    documentText: { text: "retained old source", local: null },
  };
  const failure = documentSourceError(
    new DocumentInputError("sourceUnknown"),
    attachment,
  );
  if (!(failure instanceof DocumentSourceError))
    throw new Error("expected typed document source failure");
  const approved: ApprovedDocumentText = {
    text: "Reviewed current text",
    local: {
      schema: 1,
      format: "docx",
      source: {
        root: "/owned",
        path: "/owned/old.docx",
        resolvedPath: "/owned/old.docx",
        name: attachment.name,
        size: 100,
        sha256: "a".repeat(64),
        version: "reviewed",
      },
      textSha256: "b".repeat(64),
      utf8Bytes: 21,
      selection: "read-visible-text",
      partial: false,
      partialSelected: false,
      warnings: [],
      imageReferences: 0,
    },
  };
  const applied = { ...attachment, documentText: approved };
  return {
    failure,
    confirmation: { draftKey: key, attachment, applied, approved },
  };
}
it("retires only the failed image classification notice after exact document confirmation", async () => {
  const { confirmation } = await documentSourceFixture();
  const { createDocumentInputTarget } =
    await import("../runtime/document_input_draft");
  const { attachmentPromptBlocks } =
    await import("../runtime/draft_attachments");
  const document = {
    ...confirmation.attachment,
    imageClassificationFailed: true as const,
  };
  const image = {
    id: "separate-image",
    kind: "image" as const,
    name: "unreadable.png",
  };
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [document, image],
  }));
  render().reportImport("separate unreadable image", image.id);
  render().reportImport(
    "image classification failed for the document",
    document.id,
  );
  expect(render().imageImportMessage).toBe(
    "image classification failed for the document",
  );

  const target = createDocumentInputTarget(key, document, () => true);
  expect(target.apply({ text: "unverified", local: null })).toBe(false);
  expect(render().imageImportMessage).toBe(
    "image classification failed for the document",
  );
  expect(target.apply(confirmation.approved)).toBe(true);
  await d.draftPersistence.flush();
  const draft = d.composerDrafts.read(key);
  const [applied, other] = draft.attachments;
  expect(applied.imageClassificationFailed).toBeUndefined();
  expect(other).toBe(image);
  expect(render().imageImportMessage).toBe("separate unreadable image");
  expect(attachmentPromptBlocks(draft.text, [applied], true)).toEqual([
    { type: "text", text: draft.text },
    {
      type: "resource",
      resource: {
        uri: document.uri,
        mimeType: "text/plain",
        text: confirmation.approved.text,
      },
      localDocumentText: confirmation.approved.local,
    },
  ]);
});
it("a document source failure stays until its own explicit source confirmation, even after another save succeeds", async () => {
  await writeFailure();
  const { failure, confirmation } = await documentSourceFixture();
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [confirmation.attachment],
  }));
  render().setSendFailure(failure);
  h.failing = false;
  await d.draftPersistence.flush();
  expect(render().sendError?.message).toBe(failure.message);

  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [confirmation.applied],
  }));
  await d.draftPersistence.flush();
  expect(render().sendError?.message).toBe(failure.message);
  render().documentSaved(confirmation);
  expect(render().sendError).toBeNull();
});
it("retires a document source notice when restoring the whole draft with the same attachment ID", async () => {
  const { failure, confirmation } = await documentSourceFixture();
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [confirmation.attachment],
  }));
  // The original is still active if opening the next conversation stops
  // after preserving its copy and before clearing the active input.
  await d.composerDrafts.preserveNew();
  const [[retainedKey]] = d.composerDrafts.preserved();
  const generation = d.composerDrafts.generation(key);
  render().setSendFailure(failure);
  expect(render().sendError?.message).toBe(failure.message);

  expect(await d.composerDrafts.restorePreserved(retainedKey)).toBe(true);
  const restored = d.composerDrafts.read(key);
  expect(d.composerDrafts.generation(key)).toBe(generation + 1);
  expect(restored.text).toBe("ORIGINAL");
  expect(restored.attachments).toEqual([
    { ...confirmation.attachment, recovered: true },
  ]);
  expect(restored.attachments[0]).not.toBe(confirmation.attachment);
  expect(render().sendError).toBeNull();
});
it("retires a removed document's source notice and leaves a newer warning intact after late approval", async () => {
  const { failure, confirmation } = await documentSourceFixture();
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [confirmation.attachment],
  }));
  await d.draftPersistence.flush();
  render().setSendFailure(failure);
  expect(render().sendError?.message).toBe(failure.message);
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter(
      (item) => item.id !== confirmation.attachment.id,
    ),
  }));
  expect.soft(render().sendError).toBeNull();

  const newer = { message: failure.message, detail: "unrelated later warning" };
  render().setSendError(newer);
  render().documentSaved(confirmation);
  expect(render().sendError).toEqual(newer);
  expect(d.composerDrafts.read(key).attachments).toEqual([]);
  expect(d.composerDrafts.read(key).text).toBe("ORIGINAL");
  expect(h.invoke.mock.calls.map(([name]) => name)).not.toContain(
    "session_prompt",
  );
});
it("updates an obsolete storage notice after an ordinary text edit of the same unsent input is actually saved", async () => {
  await writeFailure();
  d.composerDrafts.update(key, (draft) => ({
    ...draft,
    text: "EDITED_UNSENT_BODY",
  }));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  h.failing = false;
  await d.draftPersistence.flush();
  expect(d.composerDrafts.read(key).text).toBe("EDITED_UNSENT_BODY");
  expect(render().sendError).toBeNull();
  expect(h.invoke.mock.calls.every(([name]) => name !== "session_prompt")).toBe(
    true,
  );
});
it("ordinary text edits do not resolve the notice before the new complete revision is saved", async () => {
  await writeFailure();
  let finish!: () => void;
  h.hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.failing = false;
  d.composerDrafts.update(key, (draft) => ({ ...draft, text: "FIRST_EDIT" }));
  await vi.waitFor(() =>
    expect(d.draftPersistence.snapshot().saving).toBe(true),
  );
  d.composerDrafts.update(key, (draft) => ({ ...draft, text: "NEWEST_EDIT" }));
  expect(render().sendError?.message).toBe(storage.DRAFT_STRINGS.saveFailed);
  finish();
  await d.draftPersistence.flush();
  expect(render().sendError).toBeNull();
  expect(d.composerDrafts.read(key).text).toBe("NEWEST_EDIT");
});
it.each(["pending-send", "queue-edit", "new-choice"] as const)(
  "text continuation cannot hide %s ownership changes",
  async (change) => {
    await writeFailure();
    if (change === "new-choice") d.newConversationChoice.cwd = "/other-folder";
    else
      d.composerDrafts.update(key, (draft) => ({
        ...draft,
        text: "EDIT_AFTER_CHANGE",
        ...(change === "pending-send"
          ? { sendPending: true }
          : {
              queueEdit: {
                index: 0,
                original: [
                  { type: "text" as const, text: "other queued input" },
                ],
              },
            }),
      }));
    h.failing = false;
    await d.draftPersistence.flush();
    expect(render().sendError?.message).toBe(storage.DRAFT_STRINGS.saveFailed);
  },
);
