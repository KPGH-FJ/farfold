import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Attachment } from "../runtime/session_types";
import { MESSAGE_AUDIO_WAV_TEST_DATA } from "../runtime/message_audio_fixtures.test-support";

const h = vi.hoisted(() => ({ enabled: [] as boolean[] }));
vi.mock("./transcript-search", async (original) => ({
  ...(await original<typeof import("./transcript-search")>()),
  // A retained attachment was explicitly opened before its ancestor closed.
  useSearchExpansion: () => ({
    open: true,
    userOpen: true,
    materialized: true,
    ref: () => {},
    onToggle: () => {},
    choose: () => {},
  }),
}));
vi.mock("../runtime/use_message_media_budget", async () => {
  const { attachmentMediaAdmission } =
    await import("../runtime/message_attachments");
  return {
    useMessageMediaPreview: (attachment: Attachment, enabled: boolean) => {
      h.enabled.push(enabled);
      const admission = enabled ? attachmentMediaAdmission(attachment) : null;
      return {
        admission,
        media: admission?.status === "available" ? admission.media : null,
        failed: false,
        budgetRejected: false,
        pending: false,
        fail: () => {},
        retry: () => {},
      };
    },
  };
});

import { MessageAttachments } from "./MessageContent";
import { SearchDisclosure } from "./transcript-search";
import {
  MessageMediaVisibility,
  useMessageMediaVisibility,
} from "./message-media-visibility";

// SSR/context and enabled-signal wiring only. The resource Hook is a boundary
// spy; this is not evidence of a real lease, DOM retirement or audio playback.
const attachment: Attachment = {
  kind: "audio",
  name: "Original WAV name",
  uri: "file:///controlled/original.wav",
  text: "Original readable attachment text",
  mimeType: "audio/wav",
  data: MESSAGE_AUDIO_WAV_TEST_DATA,
};
function VisibilityProbe() {
  return <span data-media-visible={String(useMessageMediaVisibility())} />;
}
beforeEach(() => {
  h.enabled = [];
});

it("keeps the default visible path able to request an admitted preview", () => {
  const html = renderToStaticMarkup(
    <MessageAttachments attachments={[attachment]} />,
  );
  expect(h.enabled).toEqual([true]);
  expect(html).toContain("<audio");
  expect(html).toContain(`data:audio/wav;base64,${attachment.data}`);
});

it("defaults the shared boundary to visible without a provider", () => {
  expect(renderToStaticMarkup(<VisibilityProbe />)).toContain(
    'data-media-visible="true"',
  );
});

it.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
  [false, false, false],
] as const)(
  "inherits outer=%s inner=%s without reopening a hidden ancestor",
  (outer, inner, expected) => {
    const before = JSON.stringify(attachment);
    const html = renderToStaticMarkup(
      <MessageMediaVisibility visible={outer}>
        <MessageMediaVisibility visible={inner}>
          <VisibilityProbe />
          <MessageAttachments attachments={[attachment]} />
        </MessageMediaVisibility>
      </MessageMediaVisibility>,
    );
    expect(html).toContain(`data-media-visible="${expected}"`);
    expect(h.enabled).toEqual([expected]);
    expect(html.includes("<audio")).toBe(expected);
    expect(html).toContain(attachment.name);
    expect(html).toContain(attachment.uri);
    expect(html).toContain(attachment.text);
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it("keeps retained text readable under a real closed search disclosure without admitting media", () => {
  const before = JSON.stringify(attachment);
  const html = renderToStaticMarkup(
    <SearchDisclosure>
      <summary>Outer tool group</summary>
      <MessageAttachments attachments={[attachment]} />
    </SearchDisclosure>,
  );
  expect(h.enabled).toEqual([false]);
  expect(html).not.toContain("<audio");
  expect(html).not.toContain("data:audio/wav");
  expect(html).toContain(attachment.name);
  expect(html).toContain(attachment.uri);
  expect(html).toContain(attachment.text);
  expect(JSON.stringify(attachment)).toBe(before);
});
