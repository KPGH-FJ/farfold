import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import { composerDrafts } from "./drafts";
import { addPickedAttachments } from "./composer_attachment_import";
import {
  attachmentPromptBlocks,
  prepareDraftAttachments,
} from "./draft_attachments";
import { AUDIO_INPUT as S } from "./audio_input";
beforeEach(() => {
  h.invoke.mockReset();
  composerDrafts.update("new", () => ({ text: "KEEP", attachments: [] }));
});
afterEach(() => {
  composerDrafts.clear("new");
});
it.each(["audio/wav", "audio/mpeg", "audio/flac"])(
  "records candidate %s as an explicit file position and does not read audio data",
  async (mimeType) => {
    h.invoke.mockResolvedValue({ mimeType });
    const report = vi.fn();
    await addPickedAttachments("new", ["/chosen/file"], true, report);
    const [item] = composerDrafts.read("new").attachments;
    expect(item).toMatchObject({ kind: "file", mimeType, loading: false });
    expect(item.data).toBeUndefined();
    expect(item.localAudio).toBeUndefined();
    expect(h.invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "draft_attachment_audio_candidate",
    ]);
    expect(attachmentPromptBlocks("", [item], true)[0].type).toBe(
      "resource_link",
    );
    expect(report).not.toHaveBeenCalled();
  },
);
it("keeps a failed classification visible and blocks send without guessing file type", async () => {
  h.invoke.mockRejectedValue({ code: "unreadable" });
  const report = vi.fn();
  await addPickedAttachments("new", ["/chosen/file.wav"], true, report);
  const items = composerDrafts.read("new").attachments;
  expect(items[0]).toMatchObject({
    kind: "file",
    audioClassificationFailed: true,
    loading: false,
  });
  expect(report).toHaveBeenCalledWith(S.classificationFailed);
  await expect(prepareDraftAttachments(items, true)).rejects.toThrow(
    S.classificationFailed,
  );
  expect(() => attachmentPromptBlocks("", items, true)).toThrow(
    S.classificationFailed,
  );
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
it.each(["remove", "clear", "replace-path"])(
  "ignores a late candidate after %s",
  async (change) => {
    let finish!: (value: unknown) => void;
    h.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const work = addPickedAttachments(
      "new",
      ["/chosen/file.wav"],
      true,
      vi.fn(),
    );
    if (change === "remove")
      composerDrafts.update("new", (v) => ({ ...v, attachments: [] }));
    if (change === "clear") composerDrafts.clear("new");
    if (change === "replace-path")
      composerDrafts.update("new", (v) => ({
        ...v,
        attachments: v.attachments.map((a) => ({
          ...a,
          uri: "file:///chosen/other.wav",
        })),
      }));
    const kept = composerDrafts.read("new");
    finish({ mimeType: "audio/wav" });
    await work;
    expect(composerDrafts.read("new")).toBe(kept);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);
it("project selection also classifies a WAV before any ordinary text read", async () => {
  h.invoke.mockResolvedValue({ mimeType: "audio/wav" });
  await addPickedAttachments("new", ["/chosen/file.wav"], true, vi.fn(), {
    cwd: "/chosen",
    path: "file.wav",
    embed: true,
  });
  expect(h.invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
    "draft_attachment_audio_candidate",
  ]);
  expect(composerDrafts.read("new").attachments[0].kind).toBe("file");
});
