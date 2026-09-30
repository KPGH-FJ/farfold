import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type PromptBlock } from "./sessions";
import { composerDrafts, draftPersistence, draftQueues } from "./drafts";
beforeEach(() => {
  h.invoke.mockReset();
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());
function seed(id: string) {
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  s.queued = [
    [{ type: "text", text: "first" }],
    [{ type: "text", text: "second" }],
  ];
  s.queuePaused = null;
  return s;
}
it("pauses without removing original input and saves replacement by identity after the queue shifts", () => {
  const s = seed("queue-edit");
  const original = s.queued[1];
  expect(threads.beginQueueEdit(s.key, 1)).toBe(original);
  expect(s.queued).toHaveLength(2);
  expect(s.queuePaused).toBe("stopped");
  threads.dequeue(s.key, 0);
  const replacement: PromptBlock[] = [{ type: "text", text: "edited" }];
  threads.replaceQueued(s.key, original, replacement);
  expect(s.queued).toEqual([replacement]);
  expect(s.queuePaused).toBe("stopped");
  expect(draftQueues.read(s.key)?.blocks).toEqual([replacement]);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(() => threads.replaceQueued(s.key, original, replacement)).toThrow();
});
it("never edits an uncertain or submitting request, including one that changed after editing began", () => {
  const s = seed("queue-edit-busy");
  s.submitting = true;
  expect(() => threads.beginQueueEdit(s.key, 0)).toThrow();
  const original = threads.beginQueueEdit(s.key, 1);
  s.uncertainPrompt = original;
  expect(() =>
    threads.replaceQueued(s.key, original, [{ type: "text", text: "unsafe" }]),
  ).toThrow();
  expect(s.queued[1]).toBe(original);
  expect(() => threads.beginQueueEdit(s.key, 1)).toThrow();
});

it("does not release an unknown result by deleting its pending copy", async () => {
  const s = seed("queue-unknown-remove");
  const original = s.queued[0];
  s.uncertainPrompt = original;
  s.queuePaused = "uncertain";
  threads.dequeue(s.key, 0);
  expect(s.uncertainPrompt).toBe(original);
  expect(s.queued[0]).toBe(original);
  await threads.continueQueue(s.key);
  expect(s.queuePaused).toBe("uncertain");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("keeps a persisted queue editor isolated even when the dialog is closed", async () => {
  const s = seed("queue-editor-restored");
  s.queuePaused = "stopped";
  composerDrafts.update(`queue-edit:${s.key}`, () => ({
    text: "in progress",
    attachments: [],
    queueEdit: { index: 0, original: structuredClone(s.queued[0]) },
  }));
  await threads.continueQueue(s.key);
  expect(s.queuePaused).toBe("stopped");
  expect(s.submitting).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
});
