import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import {
  prepareDraftAttachments,
  validateQueuedAttachments,
} from "./draft_attachments";
import type { DraftAttachment } from "./drafts";
import { DRAFT_STRINGS } from "./draft_storage";
import type { PromptBlock } from "./session_types";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "./image_fixtures.test-support";

const files = (): DraftAttachment[] =>
  ["one", "two", "three"].map((name) => ({
    id: name,
    kind: "file",
    name: `${name}.txt`,
    uri: `file:///chosen/${name}.txt`,
    content: "previous contents",
  }));
afterEach(() => {
  h.invoke.mockReset();
  vi.unstubAllGlobals();
});

it("prepares three files without exceeding the shared read-check capacity", async () => {
  let active = 0;
  let peak = 0;
  h.invoke.mockImplementation(async (_command, { uri }) => {
    active++;
    peak = Math.max(peak, active);
    if (active > 2) {
      active--;
      throw new Error("two real file checks are still in flight");
    }
    // Complete at an async boundary, like a native file-check response.
    await Promise.resolve();
    active--;
    return `fresh:${uri}`;
  });
  const selected = files();
  const prepared = await prepareDraftAttachments(selected, true);
  expect(prepared.map((attachment) => attachment.content)).toEqual(
    selected.map((attachment) => `fresh:${attachment.uri}`),
  );
  expect(prepared.map((attachment) => attachment.id)).toEqual([
    "one",
    "two",
    "three",
  ]);
  expect(peak).toBe(1);
  expect(
    selected.every((attachment) => attachment.content === "previous contents"),
  ).toBe(true);
});

it("leaves the original batch intact and starts no later read after a failure", async () => {
  const selected = files();
  const original = structuredClone(selected);
  h.invoke
    .mockResolvedValueOnce("fresh first contents")
    .mockRejectedValueOnce("file check is still running");
  await expect(prepareDraftAttachments(selected, true)).rejects.toThrow(
    DRAFT_STRINGS.attachmentFailed,
  );
  expect(h.invoke.mock.calls).toEqual([
    ["draft_attachment_check", { uri: selected[0]!.uri, embed: true }],
    ["draft_attachment_check", { uri: selected[1]!.uri, embed: true }],
  ]);
  expect(selected).toEqual(original);
});

it("reads a local image again before preparing and dispatching, preserving its source", async () => {
  vi.stubGlobal("Image", TestImageDecoder);
  h.invoke.mockResolvedValue({
    mimeType: "image/png",
    data: PNG_IMAGE_TEST_DATA,
  });
  const image = {
    id: "image",
    kind: "image" as const,
    name: "chosen.png",
    uri: "file:///chosen.png",
    mimeType: "image/png",
    data: "stale contents",
  };
  const [prepared] = await prepareDraftAttachments([image], true);
  expect(prepared).toMatchObject({
    uri: image.uri,
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
  });
  const block = { type: "image" as const, ...image };
  await validateQueuedAttachments([block] as PromptBlock[]);
  expect(block.data).toBe(PNG_IMAGE_TEST_DATA);
  expect(h.invoke).toHaveBeenCalledTimes(2);
  expect(image.data).toBe("stale contents");
});

it("rejects nonempty invalid clipboard image data instead of sending it", async () => {
  await expect(
    prepareDraftAttachments(
      [
        {
          id: "bad",
          kind: "image",
          name: "bad.png",
          data: "not an image",
          mimeType: "image/png",
        },
      ],
      true,
    ),
  ).rejects.toThrow();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("does not use cached image data or mutate its draft or queue block when the selected file becomes unreadable", async () => {
  vi.stubGlobal("Image", TestImageDecoder);
  const image: DraftAttachment = {
    id: "kept-image",
    kind: "image",
    name: "selected.png",
    uri: "file:///selected.png",
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
    recovered: true,
  };
  const original = structuredClone(image);
  const block: PromptBlock = {
    type: "image",
    uri: image.uri,
    data: image.data!,
    mimeType: image.mimeType!,
  };
  const queued = structuredClone(block);
  h.invoke.mockRejectedValue(new Error("private OS path detail"));
  await expect(prepareDraftAttachments([image], true)).rejects.toThrow(
    "图片无法读取，请重新选择或移除",
  );
  await expect(validateQueuedAttachments([block])).rejects.toThrow(
    "图片无法读取，请重新选择或移除",
  );
  expect(image).toEqual(original);
  expect(block).toEqual(queued);
  expect(h.invoke).toHaveBeenCalledTimes(2);
});
