import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), verify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("./document_input", () => ({ verifyDocumentInput: h.verify }));
import {
  captureAttachmentReview,
  confirmAttachmentReview,
} from "./attachment_review";
import { composerDrafts, draftPersistence, draftQueues } from "./drafts";
import { threads } from "./sessions";
import { queuedAttachmentsNeedReview } from "./recovered_attachments";
import { documentAttachment, documentBlock } from "./docx_draft.test-support";

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(null);
  h.verify.mockReset().mockResolvedValue(undefined);
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  draftPersistence.lockInteraction(false);
});
afterEach(() => {
  vi.restoreAllMocks();
});
let serial = 0;
function review() {
  const key = `docx-review-${++serial}`;
  draftQueues.write(key, [[documentBlock()]], null);
  const state = threads.markOpenFailed(key, "chosen", "/owned", key, "fixture");
  state.openError = null;
  state.workEnabled = true;
  composerDrafts.update(`session:${key}`, () => ({
    text: "keep input",
    attachments: [documentAttachment(true)],
  }));
  return captureAttachmentReview(`session:${key}`, state);
}
const kept = (value: ReturnType<typeof review>) =>
  new Set(value.entries.map((entry) => entry.id));

it("explicit cold confirmation reparses draft and queue documents atomically, retaining exact chosen text and leaving the queue paused", async () => {
  const value = review(),
    original = structuredClone(value.draft.attachments[0].documentText);
  expect(
    await confirmAttachmentReview(value, kept(value), true, () => true),
  ).toBe(true);
  expect(h.verify).toHaveBeenCalledTimes(2);
  expect(
    h.verify.mock.calls.every(([, , options]) => options.reparse === true),
  ).toBe(true);
  expect(composerDrafts.read(value.draftKey).attachments[0]).toMatchObject({
    documentText: original,
    recovered: false,
  });
  expect(value.thread!.queued[0][0]).toEqual(documentBlock());
  expect(queuedAttachmentsNeedReview(value.thread!.queued[0])).toBe(false);
  expect(value.thread!.queuePaused).toBe("stopped");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("later reparse failure publishes no partial clearance and leaves the original text, source and recovery barriers intact", async () => {
  const value = review();
  h.verify
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("source changed"));
  await expect(
    confirmAttachmentReview(value, kept(value), true, () => true),
  ).rejects.toThrow("report.docx");
  expect(composerDrafts.read(value.draftKey)).toBe(value.draft);
  expect(value.thread!.queued[0]).toBe(value.queue[0]);
  expect(queuedAttachmentsNeedReview(value.thread!.queued[0])).toBe(true);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("a delayed reparse cannot overwrite input typed or source reselected during the review", async () => {
  const value = review();
  let finish!: () => void;
  h.verify.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = confirmAttachmentReview(value, kept(value), true, () => true);
  composerDrafts.update(value.draftKey, (draft) => ({
    ...draft,
    text: "newer input",
    attachments: [{ ...draft.attachments[0], uri: "file:///other.docx" }],
  }));
  const newer = composerDrafts.read(value.draftKey);
  finish();
  await expect(pending).rejects.toThrow("内容已变化");
  expect(composerDrafts.read(value.draftKey)).toBe(newer);
  expect(value.thread!.queued[0]).toBe(value.queue[0]);
  expect(queuedAttachmentsNeedReview(value.thread!.queued[0])).toBe(true);
});
