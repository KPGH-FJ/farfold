import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  composerDrafts,
  draftPersistence,
  fileFeedbackDrafts,
  newConversationChoice,
} from "./drafts";
import {
  createPreparationDraftTarget,
  type PreparationDraftTarget,
} from "./draft_preparation";
import { WORKTREE_PREPARATION_STRINGS as S } from "./worktree_preparation_strings";

const targets: PreparationDraftTarget[] = [];
function target(owns = () => true) {
  const value = createPreparationDraftTarget("/repo/tree", owns);
  targets.push(value);
  return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue(undefined);
  vi.spyOn(draftPersistence, "snapshot").mockReturnValue({
    ...draftPersistence.snapshot(),
    interactionLocked: false,
  });
  newConversationChoice.cwd = "/repo/tree";
  newConversationChoice.agentId = "chosen";
  newConversationChoice.service = {
    id: "chosen-service",
    model: "chosen-model",
    revision: "saved-revision",
  };
  newConversationChoice.config = { model: "original", reasoning: "ultra" };
  composerDrafts.update("new", () => ({
    text: "Original",
    attachments: [
      { id: "a", kind: "file", name: "note.md", uri: "file:///note.md" },
    ],
  }));
});
afterEach(() => {
  targets.splice(0).forEach((t) => t.retire());
  vi.restoreAllMocks();
  composerDrafts.clear("new");
  fileFeedbackDrafts.clear("new", "/repo/note.md");
});
it("appends only after validation and keeps actual attachments, opinions and choice", async () => {
  fileFeedbackDrafts.update("new", "/repo/note.md", {
    text: "old opinion",
    selection: null,
  });
  const before = composerDrafts.read("new"),
    feedback = fileFeedbackDrafts.entries("new"),
    choice = JSON.stringify(newConversationChoice);
  const gate = deferred(),
    t = target();
  const run = t.appendOnce("Please prepare", () => gate.promise);
  await Promise.resolve();
  expect(composerDrafts.read("new")).toBe(before);
  gate.resolve();
  expect(await run).toBe("added-saved");
  expect(composerDrafts.read("new").text).toBe("Original\n\nPlease prepare");
  expect(composerDrafts.read("new").attachments).toBe(before.attachments);
  expect(fileFeedbackDrafts.entries("new")).toBe(feedback);
  expect(JSON.stringify(newConversationChoice)).toBe(choice);
});
it("a draft edit with the same generation invalidates a late validate", async () => {
  const t = target(),
    gate = deferred(),
    generation = composerDrafts.generation("new");
  const run = t.appendOnce("Late", () => gate.promise);
  await Promise.resolve();
  composerDrafts.update("new", (draft) => ({ ...draft, text: "New text" }));
  expect(composerDrafts.generation("new")).toBe(generation);
  gate.resolve();
  expect(await run).toBe("stale");
  expect(composerDrafts.read("new").text).toBe("New text");
});
it.each(["cwd", "agentId", "config"] as const)(
  "choice %s A -> B -> A never revives an old target",
  async (field) => {
    const t = target(),
      previous = newConversationChoice[field];
    if (field === "config") {
      newConversationChoice.config = { model: "other" };
      newConversationChoice.config = previous as Record<string, unknown>;
    } else {
      newConversationChoice[field] = "other";
      newConversationChoice[field] = previous as string | null;
    }
    expect(t.isCurrent()).toBe(false);
    expect(await t.appendOnce("Late", async () => {})).toBe("stale");
  },
);
it("synchronous update subscribers and duplicate Enter cannot append twice", async () => {
  const t = target();
  let reentered: Promise<unknown> | undefined;
  const stop = composerDrafts.subscribe(() => {
    reentered = t.appendOnce("duplicate", async () => {});
  });
  const first = t.appendOnce("Once", async () => {});
  expect(await t.appendOnce("duplicate", async () => {})).toBe("stale");
  expect(await first).toBe("added-saved");
  expect(await reentered).toBe("stale");
  stop();
  expect(composerDrafts.read("new").text).toBe("Original\n\nOnce");
});
it("failed persistence after insertion only retries storage, never insertion or validation", async () => {
  vi.mocked(draftPersistence.flush)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("disk"))
    .mockResolvedValueOnce(undefined);
  const t = target(),
    validate = vi.fn().mockResolvedValue(undefined);
  expect(await t.appendOnce("Once", validate)).toBe("added-unsaved");
  const inserted = composerDrafts.read("new");
  expect(await t.retrySave()).toBe("saved");
  expect(composerDrafts.read("new")).toBe(inserted);
  expect(validate).toHaveBeenCalledOnce();
  expect(await t.appendOnce("Again", validate)).toBe("stale");
});
it("failure saving the original draft cannot insert any request", async () => {
  vi.mocked(draftPersistence.flush).mockRejectedValueOnce(new Error("disk"));
  const before = composerDrafts.read("new"),
    validate = vi.fn();
  await expect(target().appendOnce("No", validate)).rejects.toThrow(
    S.saveBeforeFailed,
  );
  expect(validate).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(before);
});
it("synchronous validation withdrawal and a closed view both prevent a late append", async () => {
  let owned = true;
  const t = target(() => owned);
  expect(
    await t.appendOnce("No", async () => {
      owned = false;
    }),
  ).toBe("stale");
  const second = target(),
    gate = deferred(),
    run = second.appendOnce("No", () => gate.promise);
  await Promise.resolve();
  second.retire();
  gate.resolve();
  expect(await run).toBe("stale");
  expect(composerDrafts.read("new").text).toBe("Original");
});
it("pending sends, loading attachments and maintenance never receive the request", async () => {
  composerDrafts.update("new", (draft) => ({ ...draft, sendPending: true }));
  expect(target().isCurrent()).toBe(false);
  composerDrafts.update("new", (draft) => ({
    ...draft,
    sendPending: false,
    attachments: [{ id: "a", name: "loading", kind: "file", loading: true }],
  }));
  expect(target().isCurrent()).toBe(false);
  composerDrafts.update("new", (draft) => ({ ...draft, attachments: [] }));
  const t = target();
  vi.mocked(draftPersistence.snapshot).mockReturnValue({
    ...draftPersistence.snapshot(),
    interactionLocked: true,
  });
  expect(t.isCurrent()).toBe(false);
});
it("a maintenance lock followed by release cannot revive an earlier append right", () => {
  vi.mocked(draftPersistence.snapshot).mockRestore();
  const t = target();
  expect(t.isCurrent()).toBe(true);
  const release = draftPersistence.acquireInteractionLock();
  expect(t.isCurrent()).toBe(false);
  release();
  expect(t.isCurrent()).toBe(false);
});

it("retry distinguishes changed original draft from a repeatable storage failure without re-inserting", async () => {
  vi.mocked(draftPersistence.flush)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("disk"))
    .mockRejectedValueOnce(new Error("disk again"));
  const t = target(),
    validate = vi.fn().mockResolvedValue(undefined);
  expect(await t.appendOnce("Once", validate)).toBe("added-unsaved");
  expect(await t.retrySave()).toBe("unsaved");
  composerDrafts.update("new", (draft) => ({
    ...draft,
    text: `${draft.text} user edit`,
  }));
  const changed = composerDrafts.read("new");
  const calls = vi.mocked(draftPersistence.flush).mock.calls.length;
  expect(await t.retrySave()).toBe("stale");
  expect(draftPersistence.flush).toHaveBeenCalledTimes(calls);
  expect(composerDrafts.read("new")).toBe(changed);
  expect(changed.text).toBe("Original\n\nOnce user edit");
  expect(validate).toHaveBeenCalledOnce();
});
