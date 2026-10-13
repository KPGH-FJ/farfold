import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import {
  AUDIO_INPUT as S,
  audioCapability,
  audioCapabilityNotice,
  audioInputFailure,
  localAudio,
  parseLocalAudio,
  readAudioInput,
  selectedAudioCandidate,
  verifyAudioInput,
} from "./audio_input";
import { audioCapture, audioAttachment } from "./audio_input.test-support";
import {
  attachmentPromptBlocks,
  prepareDraftAttachments,
  validateQueuedAttachments,
} from "./draft_attachments";
import {
  audioDraftAttachment,
  localMessageAttachments,
  promptRejectionNotice,
  wirePromptBlocks,
} from "./prompt_blocks";
import {
  normalizeMessageAttachments,
  sameOfficialAttachment,
} from "./message_attachments";
import {
  userMessageBlocks,
  userMessageDraftAttachments,
} from "./message_actions";
import { keepPromptAsDraft } from "./uncertain_prompt";
import type { PromptBlock } from "./session_types";
beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(audioCapture());
});
afterEach(() => vi.unstubAllGlobals());
it.each([undefined, null, "true", {}, 1, [], false, true])(
  "accepts only boolean capability, value %j",
  (value) => {
    const capability = audioCapability({
      agentCapabilities: { promptCapabilities: { audio: value } },
    });
    expect(capability).toBe(typeof value === "boolean" ? value : undefined);
    expect(audioCapabilityNotice(capability)).toBe(
      value === true
        ? null
        : value === false
          ? S.capabilityUnsupported
          : S.capabilityUnknown,
    );
  },
);
it("retains the complete independent WAV including RIFF header and checks its whole-file digest", async () => {
  const value = await readAudioInput("file:///chosen/sample.wav");
  const bytes = Buffer.from(value.data, "base64");
  expect(bytes.subarray(0, 12).toString("ascii")).toBe(
    "RIFFt\u0002\u0000\u0000WAVE",
  );
  expect(bytes.byteLength).toBe(636);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "eb2ff3091658e70d7364f6350c88c37321b0aac4000586fe62532054bd8b6574",
  );
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("draft_attachment_audio", {
    uri: "file:///chosen/sample.wav",
    expected: null,
  });
});
it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const)(
  "rechecks exact source %s and never adopts a changed capture",
  async (field) => {
    const original = audioAttachment(),
      before = structuredClone(original),
      response = audioCapture();
    // Modify the expected original so the response remains independently valid.
    (original.localAudio!.file as unknown as Record<string, unknown>)[field] =
      field === "size"
        ? 638
        : field === "sha256"
          ? "0".repeat(64)
          : `${response.file[field]}-changed`;
    if (field === "path") original.uri = "file:///chosen/sample.wav-changed";
    await expect(verifyAudioInput(original)).rejects.toThrow();
    expect(original.data).toBe(before.data);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);
it.each([
  (v: ReturnType<typeof audioCapture>) => ({ ...v, data: v.data.slice(0, -4) }),
  (v: ReturnType<typeof audioCapture>) => ({
    ...v,
    data: v.data.slice(0, -1) + "!",
  }),
  (v: ReturnType<typeof audioCapture>) => ({ ...v, data: " " + v.data }),
  (v: ReturnType<typeof audioCapture>) => ({ ...v, mimeType: "audio/mpeg" }),
  (v: ReturnType<typeof audioCapture>) => ({
    ...v,
    file: { ...v.file, sha256: "0".repeat(64) },
  }),
  (v: ReturnType<typeof audioCapture>) => ({ ...v, channels: 3 }),
  (v: ReturnType<typeof audioCapture>) => ({ ...v, frames: 0 }),
  (v: ReturnType<typeof audioCapture>) => ({ ...v, durationMs: 75 }),
  (v: ReturnType<typeof audioCapture>) => ({ ...v, extra: "not-authority" }),
])("rejects malformed capture at the IPC boundary", async (mutate) => {
  h.invoke.mockResolvedValue(mutate(audioCapture()));
  await expect(readAudioInput("file:///chosen/sample.wav")).rejects.toThrow(
    S.invalid,
  );
});
it.each([
  "invalid",
  "unsupported",
  "limit",
  "durationLimit",
  "changed",
  "unreadable",
  "readPending",
  "readBusy",
] as const)("maps native %s without exposing private detail", async (code) => {
  h.invoke.mockRejectedValue({
    code,
    path: "/private/user/secret",
    detail: "PRIVATE",
  });
  await expect(readAudioInput("file:///chosen/sample.wav")).rejects.toThrow(
    S[code],
  );
  expect(audioInputFailure({ code, detail: "PRIVATE" })).toBe(S[code]);
});
it("classifies without full reading and rejects malformed classifier results", async () => {
  h.invoke.mockResolvedValue({ mimeType: "audio/mpeg" });
  expect(await selectedAudioCandidate("file:///chosen/example.mp3")).toBe(
    "audio/mpeg",
  );
  expect(h.invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
    "draft_attachment_audio_candidate",
  ]);
  h.invoke.mockResolvedValue({ mimeType: "audio/wav", data: "not allowed" });
  await expect(
    selectedAudioCandidate("file:///chosen/sample.wav"),
  ).rejects.toThrow(S.classificationFailed);
});
it.each([null, {}, { file: { path: "/private/arbitrary.wav" } }])(
  "keeps historical bytes but cannot read a missing or malformed local source %j",
  async (source) => {
    const block = {
      type: "audio",
      data: audioCapture().data,
      mimeType: "audio/wav",
      uri: "file:///private/arbitrary.wav",
      localAudio: source,
    } as PromptBlock & { type: "audio" };
    const draft = audioDraftAttachment(block);
    expect(draft).toMatchObject({
      kind: "audio",
      data: block.data,
      recovered: true,
      localAudio: null,
    });
    expect(draft.uri).toBeUndefined();
    await expect(prepareDraftAttachments([draft], true)).rejects.toThrow(
      S.sourceUnknown,
    );
    await expect(validateQueuedAttachments([block])).rejects.toThrow();
    expect(h.invoke).not.toHaveBeenCalled();
  },
);
it("keeps ordinary WAV as an explicit file position even if stale text exists", async () => {
  h.invoke.mockResolvedValue(null);
  const file = {
    id: "position",
    kind: "file" as const,
    name: "sample.wav",
    uri: "file:///chosen/sample.wav",
    mimeType: "audio/wav",
    content: "not audio",
  };
  const prepared = await prepareDraftAttachments([file], true);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("draft_attachment_check", {
    uri: file.uri,
    embed: false,
  });
  expect(attachmentPromptBlocks("", prepared, true)).toEqual([
    {
      type: "resource_link",
      name: file.name,
      uri: file.uri,
      mimeType: "audio/wav",
    },
  ]);
});
it("requires restored audio review and then rechecks its original source without rewriting bytes", async () => {
  const audio = { ...audioAttachment(), recovered: true },
    before = structuredClone(audio);
  await expect(prepareDraftAttachments([audio], true)).rejects.toThrow(
    S.recoveryRequired,
  );
  expect(h.invoke).not.toHaveBeenCalled();
  expect(
    await prepareDraftAttachments([audio], true, { reparseDocuments: true }),
  ).toEqual([{ ...audio, recovered: false, loading: false }]);
  expect(audio).toEqual(before);
  h.invoke.mockRejectedValue({ code: "changed" });
  await expect(
    prepareDraftAttachments([audio], true, { reparseDocuments: true }),
  ).rejects.toThrow(S.changed);
  expect(audio).toEqual(before);
});
it("uses only the three official audio fields while retaining authority through local resend and unknown-input copies", async () => {
  const audio = audioAttachment();
  const blocks = attachmentPromptBlocks("listen", [audio], false);
  await validateQueuedAttachments(blocks);
  expect(wirePromptBlocks(blocks)).toEqual([
    { type: "text", text: "listen" },
    { type: "audio", data: audio.data, mimeType: "audio/wav" },
  ]);
  const message = localMessageAttachments(blocks);
  expect(message[0].localAudio).toEqual(audio.localAudio);
  expect(userMessageBlocks("listen", message)).toEqual(blocks);
  expect(userMessageDraftAttachments(message)[0]).toMatchObject({
    kind: "audio",
    data: audio.data,
    localAudio: audio.localAudio,
  });
  expect(
    keepPromptAsDraft({ text: "keep", attachments: [] }, blocks).attachments[0],
  ).toMatchObject({
    kind: "audio",
    data: audio.data,
    localAudio: audio.localAudio,
    recovered: true,
  });
  const echo = normalizeMessageAttachments(wirePromptBlocks(blocks));
  expect(echo[0].localAudio).toBeUndefined();
  expect(sameOfficialAttachment(message[0], echo[0])).toBe(true);
  expect(
    sameOfficialAttachment(message[0], { ...echo[0], data: "different" }),
  ).toBe(false);
});
it.each([
  "audio_unknown",
  "audio_unsupported",
  "audio_limit",
  "audio_invalid",
  "audio_format_unsupported",
  "audio_duration_limit",
] as const)("shows a retained-input admission reason for %s", (reason) => {
  expect(promptRejectionNotice({ status: "rejected", reason })).toBeTruthy();
});
it("does not accept invalid scalar or extra authority in stored metadata", () => {
  expect(parseLocalAudio(localAudio(audioCapture()))).toEqual(
    localAudio(audioCapture()),
  );
  expect(() =>
    parseLocalAudio({ ...localAudio(audioCapture()), approval: true }),
  ).toThrow(S.invalid);
});
it("uses one whole-file byte sum rule including duplicate blocks at the exact aggregate boundary", async () => {
  const { addAudioBytes, MAX_AUDIO_BYTES } = await import("./audio_input");
  expect(addAudioBytes(MAX_AUDIO_BYTES / 2, MAX_AUDIO_BYTES / 2)).toBe(
    MAX_AUDIO_BYTES,
  );
  expect(() =>
    addAudioBytes(MAX_AUDIO_BYTES / 2, MAX_AUDIO_BYTES / 2 + 2),
  ).toThrow(S.limit);
  const a = audioAttachment();
  a.localAudio!.file.size = MAX_AUDIO_BYTES / 2;
  expect(
    attachmentPromptBlocks("", [a, a], true).filter((b) => b.type === "audio"),
  ).toHaveLength(2);
  expect(() =>
    attachmentPromptBlocks(
      "",
      [
        a,
        a,
        {
          ...a,
          localAudio: {
            ...a.localAudio!,
            file: { ...a.localAudio!.file, size: 2 },
          },
        },
      ],
      true,
    ),
  ).toThrow(S.limit);
});
