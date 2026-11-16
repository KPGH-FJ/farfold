import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import { audioCapture, audioAttachment } from "./audio_input.test-support";
import { AUDIO_INPUT as S, MAX_AUDIO_BYTES } from "./audio_input";
import type { DraftAttachment } from "./drafts";
let d: typeof import("./drafts");
let create: typeof import("./audio_input_draft").createAudioInputTarget;
const original = (): DraftAttachment => ({
  id: "audio",
  kind: "file",
  uri: "file:///chosen/sample.wav",
  name: "sample.wav",
  mimeType: "audio/wav",
  deliveryMode: "location",
});
beforeEach(async () => {
  vi.resetModules();
  h.invoke.mockReset().mockResolvedValue(null);
  d = await import("./drafts");
  create = (await import("./audio_input_draft")).createAudioInputTarget;
  await d.draftPersistence.load();
  d.composerDrafts.update("new", () => ({
    text: "KEEP",
    attachments: [original()],
  }));
  await d.draftPersistence.flush();
});
afterEach(async () => {
  await d.draftPersistence.flush();
});
it.each([false, true])(
  "cancel restores exact original object, previously approved=%s",
  (approved) => {
    const selected = approved ? audioAttachment() : original();
    d.composerDrafts.update("new", () => ({
      text: "KEEP",
      attachments: [selected],
    }));
    const target = create("new", selected, () => true);
    expect(d.composerDrafts.read("new").attachments[0].loading).toBe(true);
    target.retire();
    expect(d.composerDrafts.read("new")).toEqual({
      text: "KEEP",
      attachments: [selected],
    });
    expect(d.composerDrafts.read("new").attachments[0]).toBe(selected);
    expect(target.apply(audioCapture())).toBe(false);
  },
);
it("approves once and does not transmit or mutate the originally selected file position", () => {
  const selected = d.composerDrafts.read("new").attachments[0];
  const target = create("new", selected, () => true);
  expect(target.apply(audioCapture())).toBe(true);
  expect(target.apply(audioCapture())).toBe(false);
  expect(d.composerDrafts.read("new").attachments[0]).toMatchObject(
    audioAttachment(),
  );
  expect(selected.kind).toBe("file");
  expect(
    h.invoke.mock.calls.every(([cmd]) => cmd.startsWith("settings_")),
  ).toBe(true);
});
it("explicit audio review clears file delivery and unclassified input, and remains restorable", async () => {
  d.composerDrafts.update("new", (draft) => ({
    ...draft,
    attachments: [{ ...draft.attachments[0], imageClassificationFailed: true }],
  }));
  const selected = d.composerDrafts.read("new").attachments[0];
  expect(selected.deliveryMode).toBe("location");
  const target = create("new", selected, () => true);
  expect(target.apply(audioCapture())).toBe(true);
  expect(
    d.composerDrafts.read("new").attachments[0].deliveryMode,
  ).toBeUndefined();
  expect(
    d.composerDrafts.read("new").attachments[0].imageClassificationFailed,
  ).toBeUndefined();
  await d.draftPersistence.flush();
  const saved = h.invoke.mock.calls
    .filter(([command]) => command === "settings_set")
    .at(-1)![1].value;
  expect(
    d.parseDraftSnapshot(saved)?.composers.find(([key]) => key === "new")![1]
      .attachments[0],
  ).toMatchObject({ kind: "audio", recovered: true });
  expect(selected.deliveryMode).toBe("location");
  expect(selected.imageClassificationFailed).toBe(true);
});
it.each([
  "text",
  "remove-readd",
  "clear-readd",
  "choice-revert",
  "sendPending",
  "path-replace",
])(
  "rejects a late approval after %s without replacing subsequent input",
  (change) => {
    const selected = d.composerDrafts.read("new").attachments[0],
      target = create("new", selected, () => true);
    if (change === "text")
      d.composerDrafts.update("new", (v) => ({ ...v, text: "NEW" }));
    if (change === "remove-readd") {
      d.composerDrafts.update("new", (v) => ({ ...v, attachments: [] }));
      d.composerDrafts.update("new", (v) => ({
        ...v,
        attachments: [selected],
      }));
    }
    if (change === "clear-readd") {
      d.composerDrafts.clear("new");
      d.composerDrafts.update("new", () => ({
        text: "NEW",
        attachments: [selected],
      }));
    }
    if (change === "choice-revert") {
      const old = d.newConversationChoice.agentId;
      d.newConversationChoice.agentId = "other";
      d.composerDrafts.update("new", (v) => ({ ...v }));
      d.newConversationChoice.agentId = old;
    }
    if (change === "sendPending")
      d.composerDrafts.update("new", (v) => ({ ...v, sendPending: true }));
    if (change === "path-replace")
      d.composerDrafts.update("new", (v) => ({
        ...v,
        attachments: [{ ...selected, uri: "file:///new.wav" }],
      }));
    const changed = d.composerDrafts.read("new");
    expect(target.apply(audioCapture())).toBe(false);
    expect(d.composerDrafts.read("new")).toBe(changed);
    target.retire();
  },
);
it("limits the aggregate at approval and counts duplicate complete files separately", () => {
  const selected = original(),
    other = audioAttachment();
  other.id = "other";
  other.localAudio!.file.size = MAX_AUDIO_BYTES - audioCapture().file.size + 1;
  d.composerDrafts.update("new", () => ({
    text: "KEEP",
    attachments: [selected, other],
  }));
  const target = create("new", selected, () => true);
  expect(() => target.apply(audioCapture())).toThrow(S.limit);
  target.retire();
  expect(d.composerDrafts.read("new").attachments).toEqual([selected, other]);
  other.localAudio!.file.size--;
  const exact = create("new", selected, () => true);
  expect(exact.apply(audioCapture())).toBe(true);
});
it("does not adopt the same bytes from a different path", () => {
  const target = create(
    "new",
    d.composerDrafts.read("new").attachments[0],
    () => true,
  );
  const capture = audioCapture();
  capture.file.path = "/chosen/another.wav";
  expect(target.apply(capture)).toBe(false);
  target.retire();
});
it("cold restoration preserves complete bytes in draft and queue, adds a review barrier, and makes no file or send calls", async () => {
  const audio = audioAttachment(),
    block = {
      type: "audio",
      data: audio.data,
      mimeType: audio.mimeType,
      uri: audio.uri,
      localAudio: audio.localAudio,
    };
  const persisted = {
    version: 1,
    composers: { new: { text: "KEEP", attachments: [audio] } },
    choice: { agentId: "chosen", cwd: "/chosen", service: null, config: {} },
    feedback: {},
    queues: {
      sample: { blocks: [[block]], uncertainIndex: null },
    },
  };
  vi.resetModules();
  h.invoke.mockReset().mockResolvedValue(persisted);
  d = await import("./drafts");
  await d.draftPersistence.load();
  expect(d.composerDrafts.read("new").attachments[0]).toMatchObject({
    ...audio,
    recovered: true,
  });
  expect(d.draftQueues.read("sample")?.blocks[0][0]).toEqual(block);
  expect(h.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["settings_get"]);
});
it.each([null, { file: { path: "/private/arbitrary.wav" } }])(
  "cold restoration keeps bytes with unusable source %j",
  async (localAudio) => {
    const audio = { ...audioAttachment(), localAudio };
    vi.resetModules();
    h.invoke.mockReset().mockResolvedValue({
      version: 1,
      composers: { new: { text: "KEEP", attachments: [audio] } },
      choice: {
        agentId: "chosen",
        cwd: "/chosen",
        service: null,
        config: {},
      },
      feedback: {},
      queues: {},
    });
    d = await import("./drafts");
    await d.draftPersistence.load();
    expect(d.composerDrafts.read("new").attachments[0]).toMatchObject({
      kind: "audio",
      data: audio.data,
      localAudio: null,
      recovered: true,
    });
    expect(h.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["settings_get"]);
  },
);

it("an explicit same-path reselection remains reachable after cold restoration of source-less audio, keeping original bytes", async () => {
  const original = {
    ...audioAttachment(),
    localAudio: null,
    uri: "file:///chosen/sample.wav",
  };
  vi.resetModules();
  h.invoke.mockReset().mockImplementation(async (cmd) =>
    cmd === "settings_get"
      ? {
          version: 1,
          composers: { new: { text: "KEEP", attachments: [original] } },
          choice: {
            agentId: "chosen",
            cwd: "/chosen",
            service: null,
            config: {},
          },
          feedback: {},
          queues: {},
        }
      : cmd === "draft_attachment_audio_candidate"
        ? { mimeType: "audio/wav" }
        : undefined,
  );
  d = await import("./drafts");
  await d.draftPersistence.load();
  const old = d.composerDrafts.read("new").attachments[0];
  expect(old.uri).toBeUndefined();
  expect(old.data).toBe(original.data);
  const { addPickedAttachments } = await import("./composer_attachment_import");
  await addPickedAttachments("new", ["/chosen/sample.wav"], true, vi.fn());
  expect(d.composerDrafts.read("new").attachments).toHaveLength(2);
  expect(d.composerDrafts.read("new").attachments[0]).toBe(old);
  expect(d.composerDrafts.read("new").attachments[1]).toMatchObject({
    kind: "file",
    uri: "file:///chosen/sample.wav",
    mimeType: "audio/wav",
  });
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "draft_attachment_audio"),
  ).toHaveLength(0);
});
