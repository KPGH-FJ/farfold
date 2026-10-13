import { expect, it } from "vitest";
import { AudioInputError } from "./audio_input";
import { audioAttachment } from "./audio_input.test-support";
import {
  AudioSourceError,
  audioSourceError,
  resolvedAudioSourceNotice,
} from "./audio_source_error";
function fixture() {
  const attachment = audioAttachment(),
    applied = audioAttachment(),
    error = audioSourceError(
      new AudioInputError("changed"),
      attachment,
    ) as AudioSourceError,
    notice = { draftKey: "owned", errorContext: "current", error },
    confirmation = { draftKey: "owned", attachment, applied },
    draft = { text: "KEEP", attachments: [applied] };
  return { attachment, applied, error, notice, confirmation, draft };
}
it("attributes only source failures to the exact attachment", () => {
  const f = fixture();
  expect(f.error).toBeInstanceOf(AudioInputError);
  expect(f.error.attachment).toBe(f.attachment);
  const ordinary = new Error(f.error.message);
  expect(audioSourceError(ordinary, f.attachment)).toBe(ordinary);
  const limit = new AudioInputError("limit");
  expect(audioSourceError(limit, f.attachment)).toBe(limit);
});
it("clears its source notice only after that exact original is freshly approved and currently installed", () => {
  const f = fixture();
  expect(
    resolvedAudioSourceNotice(
      f.notice,
      "owned",
      "current",
      f.confirmation,
      f.draft,
    ),
  ).toBe(true);
  for (const current of [
    { ...f.draft, sendPending: true },
    { ...f.draft, pendingConversation: {} },
    { ...f.draft, attachments: [f.attachment] },
    { ...f.draft, attachments: [{ ...f.applied }] },
  ])
    expect(
      resolvedAudioSourceNotice(
        f.notice,
        "owned",
        "current",
        f.confirmation,
        current as typeof f.draft,
      ),
    ).toBe(false);
});
it("another attachment, remove-readd, cancelled review or later context cannot clear the source error", () => {
  const f = fixture();
  expect(
    resolvedAudioSourceNotice(
      f.notice,
      "owned",
      "current",
      { ...f.confirmation, attachment: { ...f.attachment } },
      f.draft,
    ),
  ).toBe(false);
  expect(
    resolvedAudioSourceNotice(
      f.notice,
      "other",
      "current",
      f.confirmation,
      f.draft,
    ),
  ).toBe(false);
  expect(
    resolvedAudioSourceNotice(
      f.notice,
      "owned",
      "later",
      f.confirmation,
      f.draft,
    ),
  ).toBe(false);
  expect(
    resolvedAudioSourceNotice(
      null,
      "owned",
      "current",
      f.confirmation,
      f.draft,
    ),
  ).toBe(false);
});
it("in-place changes to an old local source or attachment identity cannot clear its previous notice", () => {
  for (const change of ["id", "local", "data"]) {
    const f = fixture();
    if (change === "id") f.attachment.id = "later";
    if (change === "local")
      f.attachment.localAudio = audioAttachment().localAudio;
    if (change === "data") f.attachment.data = "later";
    expect(
      resolvedAudioSourceNotice(
        f.notice,
        "owned",
        "current",
        f.confirmation,
        f.draft,
      ),
    ).toBe(false);
  }
});
