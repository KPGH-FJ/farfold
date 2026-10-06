import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
import { composerDrafts, draftPersistence, hasUnsentWork } from "./drafts";
import {
  keepQueueEditAsDraft,
  queueEditorKey,
  queueEditorTarget,
  startQueueEditor,
} from "./queue_edit";
import type { PromptBlock } from "./session_types";
import { keepPromptAsDraft } from "./uncertain_prompt";

it("edits an independent copy with all attachment kinds and cannot replace a shifted or changed original", async () => {
  await draftPersistence.load();
  const key = "queue-editor-attachments";
  const image = {
    type: "image" as const,
    data: "image-data",
    mimeType: "image/png",
    uri: "file:///tmp/chosen.png",
  };
  const original: PromptBlock[] = [
    { type: "text", text: "question" },
    image,
    {
      type: "resource",
      resource: {
        uri: "file:///tmp/current.txt",
        text: "outdated",
        mimeType: "text/plain",
      },
    },
  ];
  composerDrafts.update(`session:${key}`, () => ({
    text: "keep main input",
    attachments: [],
  }));
  startQueueEditor(key, 1, original);
  const edit = composerDrafts.read(queueEditorKey(key));
  expect(edit.attachments).toHaveLength(2);
  expect(edit.attachments[0].uri).toBe(image.uri);
  expect(
    keepPromptAsDraft({ text: "kept", attachments: [] }, original)
      .attachments[0].uri,
  ).toBe(image.uri);
  expect(edit.attachments[1].content).toBeUndefined();
  expect(composerDrafts.read(`session:${key}`).text).toBe("keep main input");
  expect(queueEditorTarget(edit, [[], original])).toBe(original);
  expect(queueEditorTarget(edit, [original])).toBe(original);
  expect(
    queueEditorTarget(edit, [[], [{ type: "text", text: "changed" }]]),
  ).toBeNull();
  expect(hasUnsentWork(key)).toBe(true);
  keepQueueEditAsDraft(key);
  expect(composerDrafts.read(`session:${key}`)).toMatchObject({
    text: "keep main input\n\nquestion",
  });
  expect(composerDrafts.read(`session:${key}`).attachments).toHaveLength(2);
  expect(composerDrafts.read(queueEditorKey(key)).queueEdit).toBeUndefined();
  expect(original[0]).toEqual({ type: "text", text: "question" });
});

it("follows the same item when a preceding admission shifts identical queued messages, and never guesses a cold identity", () => {
  const first: PromptBlock[] = [{ type: "text", text: "identical" }];
  const second = structuredClone(first);
  startQueueEditor("queue-duplicate", 1, first);
  const editing = composerDrafts.read(queueEditorKey("queue-duplicate"));
  expect(queueEditorTarget(editing, [first, second])).toBe(first);
  expect(queueEditorTarget(editing, [second])).toBeNull();
  expect(
    queueEditorTarget(structuredClone(editing), [first, second]),
  ).toBeNull();
});
