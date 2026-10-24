import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import {
  composerDrafts,
  draftPersistence,
  draftQueues,
  type DraftAttachment,
} from "./drafts";
import { threads } from "./sessions";
import type { PromptBlock } from "./session_types";
import {
  captureAttachmentReview,
  confirmAttachmentReview,
} from "./attachment_review";
import { queuedAttachmentsNeedReview } from "./recovered_attachments";
import { canDrain } from "./queue";
import { FILE_DELIVERY_STRINGS } from "./file_delivery_strings";
import { startQueueEditor, queueEditorKey } from "./queue_edit";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "./image_fixtures.test-support";

let serial = 0;
const file = (name = "notes.md", recovered = true): DraftAttachment => ({
  id: name,
  kind: "file",
  name,
  uri: `file:///p/${name}`,
  recovered,
});
const resource = (name: string): PromptBlock => ({
  type: "resource",
  resource: {
    uri: `file:///p/${name}`,
    mimeType: "text/plain",
    text: "old contents",
  },
});
const text = (value: string): PromptBlock => ({ type: "text", text: value });
const image = (data = PNG_IMAGE_TEST_DATA): PromptBlock => ({
  type: "image",
  data,
  mimeType: "image/png",
});
function seed(queue: PromptBlock[][], uncertainIndex: number | null = null) {
  const key = `review-${++serial}`;
  draftQueues.write(key, queue, uncertainIndex);
  const state = threads.markOpenFailed(key, "generic", "/p", key, "fixture");
  state.openError = null;
  state.workEnabled = true;
  return state;
}
const keepAll = (review: ReturnType<typeof captureAttachmentReview>) =>
  new Set(review.entries.map((entry) => entry.id));
beforeEach(() => {
  vi.stubGlobal("Image", TestImageDecoder);
  h.invoke.mockReset().mockResolvedValue("current contents");
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  draftPersistence.lockInteraction(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("marks only actual restored attachment queues and blocks both draining and explicit continuation before review", async () => {
  const state = seed([[text("first")], [text("second"), resource("notes.md")]]);
  expect(queuedAttachmentsNeedReview(state.queued[0])).toBe(false);
  expect(queuedAttachmentsNeedReview(state.queued[1])).toBe(true);
  expect(queuedAttachmentsNeedReview([resource("new.md")])).toBe(false);
  expect(canDrain({ ...state, queuePaused: null })).toBe(false);
  await threads.continueQueue(state.key);
  expect(state.queuePaused).toBe("stopped");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("checks kept files before applying draft and queue choices, preserving body, order, other drafts and unknown input", async () => {
  const state = seed([
    [text("first")],
    [image()],
    [text("third"), resource("queue.md")],
  ]);
  const key = `session:${state.key}`;
  const added = file("new.md", false);
  composerDrafts.update(key, () => ({
    text: "  Draft body\n",
    attachments: [file(), file("remove.md"), added],
  }));
  composerDrafts.update("unrelated-review-draft", () => ({
    text: "Other",
    attachments: [file("other.md")],
  }));
  const other = composerDrafts.read("unrelated-review-draft");
  const first = state.queued[0];
  const review = captureAttachmentReview(key, state);
  const kept = new Set(["draft:0", "queue:2:1"]);
  const send = vi.spyOn(threads, "send"),
    resume = vi.spyOn(threads, "continueQueue");
  expect(await confirmAttachmentReview(review, kept, true, () => true)).toBe(
    true,
  );
  expect(composerDrafts.read(key)).toEqual({
    text: "  Draft body\n",
    attachments: [
      {
        ...file(),
        content: "current contents",
        recovered: false,
        loading: false,
      },
      added,
    ],
  });
  expect(composerDrafts.read("unrelated-review-draft")).toBe(other);
  expect(state.queued[0]).toBe(first);
  expect(state.queued).toEqual([
    [text("first")],
    [
      text("third"),
      {
        type: "resource",
        resource: {
          uri: "file:///p/queue.md",
          mimeType: "text/plain",
          text: "current contents",
        },
      },
    ],
  ]);
  expect(state.queued.some(queuedAttachmentsNeedReview)).toBe(false);
  expect(state.queuePaused).toBe("stopped");
  expect(canDrain(state)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(h.invoke.mock.calls).toEqual([
    ["draft_attachment_check", { uri: "file:///p/notes.md", embed: true }],
    ["draft_attachment_check", { uri: "file:///p/queue.md", embed: true }],
  ]);
});

it("never publishes a partial confirmation when a later file is unreadable, and allows unchecking that file", async () => {
  const state = seed([[text("queue"), resource("missing.md")]]);
  const key = `session:${state.key}`;
  composerDrafts.update(key, () => ({
    text: "keep body",
    attachments: [file()],
  }));
  const review = captureAttachmentReview(key, state);
  h.invoke.mockImplementation(async (_command, { uri }) => {
    if (uri.endsWith("missing.md")) throw new Error("no longer present");
    return "new text";
  });
  await expect(
    confirmAttachmentReview(review, keepAll(review), true, () => true),
  ).rejects.toThrow("missing.md");
  expect(composerDrafts.read(key)).toBe(review.draft);
  expect(state.queued[0]).toBe(review.queue[0]);
  expect(queuedAttachmentsNeedReview(state.queued[0])).toBe(true);
  h.invoke.mockClear();
  await confirmAttachmentReview(
    review,
    new Set(["draft:0"]),
    false,
    () => true,
  );
  expect(state.queued).toEqual([[text("queue")]]);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("draft_attachment_check", {
    uri: "file:///p/notes.md",
    embed: false,
  });
});

it.each(["draft", "queue"])(
  "preserves the check-pending result during %s recovery without granting readiness or resending",
  async (source) => {
    const state = seed(
      source === "queue"
        ? [[text("keep queued body"), resource("owned.pptx")]]
        : [],
    );
    const key = `session:${state.key}`;
    composerDrafts.update(key, () => ({
      text: "keep draft body",
      attachments: source === "draft" ? [file("owned.pptx")] : [],
    }));
    const review = captureAttachmentReview(key, state);
    h.invoke.mockRejectedValueOnce({ code: "checkPending" });
    const send = vi.spyOn(threads, "send");
    const resume = vi.spyOn(threads, "continueQueue");
    await expect(
      confirmAttachmentReview(review, keepAll(review), true, () => true),
    ).rejects.toThrow(FILE_DELIVERY_STRINGS.checkWaitExpired);
    expect(composerDrafts.read(key)).toBe(review.draft);
    expect(state.queued).toEqual(review.queue);
    expect(send).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "canceling before or during validation leaves all input unchanged: during=%s",
  async (during) => {
    const key = `cancel-${++serial}`;
    composerDrafts.update(key, () => ({ text: "keep", attachments: [file()] }));
    const review = captureAttachmentReview(key, null);
    let current = during;
    let finish!: (value: string) => void;
    h.invoke.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = confirmAttachmentReview(
      review,
      keepAll(review),
      true,
      () => current,
    );
    current = false;
    finish("late contents");
    expect(await pending).toBe(false);
    expect(composerDrafts.read(key)).toBe(review.draft);
    expect(h.invoke).toHaveBeenCalledTimes(during ? 1 : 0);
  },
);

it.each(["draft", "queue", "uncertain", "exit"])(
  "rejects a stale %s after reading without overwriting any newer input",
  async (change) => {
    const state = seed([[text("queue"), resource("queue.md")]]);
    const key = `session:${state.key}`;
    composerDrafts.update(key, () => ({
      text: "before",
      attachments: [file()],
    }));
    const review = captureAttachmentReview(key, state);
    let finish!: (value: string) => void;
    h.invoke.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = confirmAttachmentReview(
      review,
      keepAll(review),
      true,
      () => true,
    );
    if (change === "draft")
      composerDrafts.update(key, (draft) => ({
        ...draft,
        text: "newer draft",
      }));
    if (change === "queue") state.queued.push([text("new tail")]);
    if (change === "uncertain") state.uncertainPrompt = state.queued[0];
    if (change === "exit") draftPersistence.lockInteraction(true);
    const beforeDraft = composerDrafts.read(key),
      beforeQueue = [...state.queued];
    finish("late contents");
    await expect(pending).rejects.toThrow("内容已变化");
    expect(composerDrafts.read(key)).toBe(beforeDraft);
    beforeQueue.forEach((blocks, index) =>
      expect(state.queued[index]).toBe(blocks),
    );
    expect(queuedAttachmentsNeedReview(state.queued[0])).toBe(true);
  },
);

it("keeps unconfirmed draft and queue attachments locked while allowing independent later queued input to be reviewed", async () => {
  const state = seed(
    [
      [text("unknown"), resource("unknown.md")],
      [text("safe"), image()],
    ],
    0,
  );
  const key = `session:${state.key}`;
  composerDrafts.update(key, () => ({
    text: "pending",
    attachments: [file()],
    sendPending: true,
    pendingConversation: {
      agentId: "generic",
      cwd: "/p",
      nativeSessionId: "unknown",
    },
  }));
  const review = captureAttachmentReview(key, state),
    original = state.uncertainPrompt;
  expect(review.entries.map((entry) => !!entry.locked)).toEqual([
    true,
    true,
    false,
  ]);
  await confirmAttachmentReview(review, new Set(), false, () => true);
  expect(composerDrafts.read(key)).toBe(review.draft);
  expect(state.uncertainPrompt).toBe(original);
  expect(state.queued[0]).toBe(original);
  expect(state.queued[1]).toEqual([text("safe")]);
  expect(state.queuePaused).toBe("uncertain");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("rejects missing stored image contents and preserves its review barrier", async () => {
  const state = seed([[text("question"), image("")]]);
  const review = captureAttachmentReview(`session:${state.key}`, state);
  await expect(
    confirmAttachmentReview(review, keepAll(review), false, () => true),
  ).rejects.toThrow("图片");
  expect(state.queued[0]).toBe(review.queue[0]);
  expect(queuedAttachmentsNeedReview(state.queued[0])).toBe(true);
});

it("carries restored-attachment review into queue editing without labeling ordinary new queue edits as restored", () => {
  const state = seed([[text("restored"), resource("file.md"), image()]]);
  startQueueEditor(state.key, 0, state.queued[0]);
  expect(
    composerDrafts
      .read(queueEditorKey(state.key))
      .attachments.every((item) => item.recovered),
  ).toBe(true);
  const fresh = [text("fresh"), resource("file.md"), image()];
  startQueueEditor("fresh-review-editor", 0, fresh);
  expect(
    composerDrafts
      .read(queueEditorKey("fresh-review-editor"))
      .attachments.some((item) => item.recovered),
  ).toBe(false);
});
