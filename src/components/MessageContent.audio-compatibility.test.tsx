import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAttachments } from "./MessageContent";
import { attachmentMediaAdmission } from "../runtime/message_attachments";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";
import { MESSAGE_AUDIO_WAV_TEST_DATA } from "../runtime/message_audio_fixtures.test-support";
import { MESSAGE_FLAC_TEST_DATA } from "../runtime/message_flac_fixtures.test-support";
import { MESSAGE_ADTS_TEST_DATA } from "../runtime/message_adts_fixtures.test-support";
import { id3PrefixTestFile } from "../runtime/message_audio_prefix_fixtures.test-support";
import type { Attachment } from "../runtime/session_types";

vi.mock("./transcript-search", () => ({
  useSearchExpansion: () => ({
    open: true,
    userOpen: true,
    materialized: true,
    ref: () => {},
    onToggle: () => {},
    choose: () => {},
  }),
}));
vi.mock("../runtime/use_message_media_budget", () => ({
  useMessageMediaPreview: (attachment: Attachment) => ({
    admission: attachmentMediaAdmission(attachment),
    media: null,
    failed: true,
    budgetRejected: false,
    pending: false,
    retry: () => {},
  }),
}));
// Check whether the failed attachment offers the platform check at all.
// SSR does not run effects or play the fixture.
vi.mock("./MessageAudioCompatibility", () => ({
  MessageAudioCompatibility: () => <button>{S.audioCompatibility}</button>,
}));

it.each([
  ["PCM WAVE", "audio/wav", MESSAGE_AUDIO_WAV_TEST_DATA, false],
  [
    "ID3-prefixed ADTS",
    "audio/aac",
    id3PrefixTestFile(MESSAGE_ADTS_TEST_DATA.TINY),
    false,
  ],
  ["untagged ADTS", "audio/mpeg", MESSAGE_ADTS_TEST_DATA.TINY, true],
  ["native FLAC", "audio/flac", MESSAGE_FLAC_TEST_DATA.TINY, true],
] as const)(
  "shows only available recovery actions for %s",
  (name, mimeType, data, compatible) => {
    const attachment = { name, mimeType, data };
    expect(attachmentMediaAdmission(attachment).status).toBe("available");
    const html = renderToStaticMarkup(
      <MessageAttachments attachments={[attachment]} />,
    );
    expect(html).toContain(S.audioFailed);
    expect(html).toContain(S.retryMedia);
    expect(html.includes(S.audioCompatibility)).toBe(compatible);
  },
);
