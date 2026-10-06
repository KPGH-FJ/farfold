import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import {
  addClipboardImages,
  addPickedAttachments,
} from "./composer_attachment_import";
import { composerDrafts } from "./drafts";
import {
  attachmentPromptBlocks,
  prepareDraftAttachments,
} from "./draft_attachments";
import { IMAGE_INPUT_STRINGS } from "./draft_images";
import { IMAGE_BYTES_STRINGS } from "./image_bytes";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "./image_fixtures.test-support";

const key = "new";
beforeEach(() => {
  composerDrafts.update(key, () => ({ text: "keep my text", attachments: [] }));
  vi.stubGlobal("Image", TestImageDecoder);
});
afterEach(() => {
  composerDrafts.clear(key);
  composerDrafts.clear("session:other");
  vi.unstubAllGlobals();
  h.invoke.mockReset();
});

it("imports a recognized image through the ordinary file entry and preserves its URI on ACP content", async () => {
  h.invoke.mockResolvedValue({
    mimeType: "image/png",
    data: PNG_IMAGE_TEST_DATA,
  });
  const report = vi.fn();
  await addPickedAttachments(key, ["/chosen/actually-image.txt"], true, report);
  const draft = composerDrafts.read(key);
  expect(draft.text).toBe("keep my text");
  expect(draft.attachments[0]).toMatchObject({
    kind: "image",
    name: "actually-image.txt",
    uri: "file:///chosen/actually-image.txt",
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
    loading: false,
  });
  expect(
    attachmentPromptBlocks(draft.text, draft.attachments, true)[1],
  ).toMatchObject({
    type: "image",
    uri: draft.attachments[0].uri,
    data: PNG_IMAGE_TEST_DATA,
  });
  expect(report).not.toHaveBeenCalled();
});

it("keeps capability-disabled images as file links without requesting bitmap data or text embedding", async () => {
  h.invoke
    .mockResolvedValueOnce({ mimeType: "image/png", data: null })
    .mockResolvedValueOnce(null);
  const report = vi.fn();
  await addPickedAttachments(key, ["/chosen.png"], false, report);
  const draft = composerDrafts.read(key);
  expect(draft.attachments[0]).toMatchObject({
    kind: "file",
    uri: "file:///chosen.png",
    mimeType: "image/png",
    loading: false,
  });
  const prepared = await prepareDraftAttachments(draft.attachments, true);
  expect(h.invoke.mock.calls).toEqual([
    ["draft_attachment_image", { uri: "file:///chosen.png", read: false }],
    ["draft_attachment_check", { uri: "file:///chosen.png", embed: false }],
  ]);
  expect(attachmentPromptBlocks(draft.text, prepared, true)[1]).toEqual({
    type: "resource_link",
    name: "chosen.png",
    uri: "file:///chosen.png",
    mimeType: "image/png",
  });
  expect(report).toHaveBeenCalledExactlyOnceWith(IMAGE_INPUT_STRINGS.linkOnly);
});

it("retains invalid bounded image data and its selected source while reporting a fixed failure", async () => {
  h.invoke.mockResolvedValue({ mimeType: "image/png", data: "AAAA" });
  const report = vi.fn();
  await addPickedAttachments(key, ["/chosen.png"], true, report);
  expect(composerDrafts.read(key)).toMatchObject({
    text: "keep my text",
    attachments: [
      {
        kind: "image",
        uri: "file:///chosen.png",
        data: "AAAA",
        loading: false,
      },
    ],
  });
  expect(report).toHaveBeenCalledExactlyOnceWith(IMAGE_BYTES_STRINGS.invalid);
});

it("discards a late read after its draft is cleared without adding it to later input or another conversation", async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const report = vi.fn();
  const pending = addPickedAttachments(key, ["/chosen.png"], true, report);
  composerDrafts.clear(key);
  composerDrafts.update(key, () => ({ text: "later input", attachments: [] }));
  composerDrafts.update("session:other", () => ({
    text: "another conversation",
    attachments: [],
  }));
  const later = composerDrafts.read(key),
    other = composerDrafts.read("session:other");
  finish({ mimeType: "image/png", data: PNG_IMAGE_TEST_DATA });
  await pending;
  expect(composerDrafts.read(key)).toBe(later);
  expect(composerDrafts.read("session:other")).toBe(other);
  expect(report).not.toHaveBeenCalled();
});

it("keeps refused clipboard contents as unsent data and never starts the browser decoder for SVG", async () => {
  const image = vi.fn();
  vi.stubGlobal("Image", image);
  const bytes = new TextEncoder().encode(
    "<svg xmlns='http://www.w3.org/2000/svg'/>",
  );
  const file = {
    name: "clipboard.svg",
    type: "image/svg+xml",
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
  const report = vi.fn();
  await addClipboardImages(key, [file], report);
  expect(composerDrafts.read(key)).toMatchObject({
    text: "keep my text",
    attachments: [
      {
        kind: "image",
        name: "clipboard.svg",
        data: btoa(String.fromCharCode(...bytes)),
        loading: false,
      },
    ],
  });
  expect(image).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledExactlyOnceWith(IMAGE_BYTES_STRINGS.invalid);
  expect(h.invoke).not.toHaveBeenCalled();
});
