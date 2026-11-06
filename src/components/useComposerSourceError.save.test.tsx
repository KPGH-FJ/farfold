import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
it("a document source failure stays until its own explicit source confirmation, even after another save succeeds", async () => {
  await writeFailure();
  const { DocumentInputError } =
    await import("../runtime/document_input_types");
  const { documentSourceError } =
    await import("../runtime/document_source_error");
  const attachment = {
    id: "old-file",
    kind: "file" as const,
    name: "old.xlsx",
    uri: "file:///owned/old.xlsx",
    documentText: { text: "retained old source", local: null },
  };
  const failure = documentSourceError(
    new DocumentInputError("sourceUnknown"),
    attachment,
  );
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error))
    throw new Error("expected typed source failure");
  render().setSendFailure(failure);
  h.failing = false;
  await d.draftPersistence.flush();
  expect(render().sendError?.message).toBe(failure.message);
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
