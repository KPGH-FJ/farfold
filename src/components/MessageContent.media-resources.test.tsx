import { beforeEach, expect, it, vi } from "vitest";

// Presentation of computed format feedback. SSR does not commit layout effects;
// real Hook, quota, pending and visibility tests are covered separately.
vi.mock("../runtime/use_message_media_budget", async () => {
  const { computedAdmissionForSsr } =
    await import("./message_media_ssr.test-support");
  return { useMessageMediaPreview: computedAdmissionForSsr };
});
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAttachments } from "./MessageContent";
import { MESSAGE_AVIF_TEST_DATA } from "../runtime/message_avif_fixtures.test-support";
import {
  MESSAGE_AUDIO_WAV_TEST_DATA,
  wavTestFile,
} from "../runtime/message_audio_fixtures.test-support";

const h = vi.hoisted(() => ({ userOpen: true }));
vi.mock("./transcript-search", () => ({
  useSearchExpansion: () => ({
    open: true,
    userOpen: h.userOpen,
    materialized: true,
    ref: () => {},
    onToggle: () => {},
    choose: () => {},
  }),
}));
beforeEach(() => {
  h.userOpen = true;
});

// Container declarations only. Do not send either oversized sample to a codec.
function largeAvif(): string {
  const bytes = Buffer.from(MESSAGE_AVIF_TEST_DATA.STATIC, "base64");
  const ispe = bytes.indexOf("ispe");
  if (ispe < 0) throw new Error("Missing owned AVIF extent fixture");
  bytes.writeUInt32BE(8193, ispe + 8);
  return bytes.toString("base64");
}

it.each(["image/avif", "image/jpeg"])(
  "refuses an AVIF canvas under %s while retaining its source and following text",
  (mimeType) => {
    const attachment = {
      name: "Original AVIF",
      uri: "file:///owned/original.avif",
      mimeType,
      data: largeAvif(),
    };
    const before = JSON.stringify(attachment);
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          attachment,
          { name: "Following text", text: "Keep this later body" },
        ]}
      />,
    );
    expect(html).toContain("图片尺寸过大");
    expect(html).toContain("file:///owned/original.avif");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("重新载入");
    expect(html.indexOf("Original AVIF")).toBeLessThan(
      html.indexOf("Following text"),
    );
    expect(html).toContain("Keep this later body");
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it.each(["audio/wav", "audio/mpeg"])(
  "explains a recognized WAV duration refusal under %s before creating audio",
  (mimeType) => {
    const attachment = {
      name: "Original WAV",
      uri: "file:///owned/original.wav",
      mimeType,
      data: wavTestFile({ sampleRate: 1, frames: 601 }).toString("base64"),
    };
    const before = JSON.stringify(attachment);
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          attachment,
          { name: "Following text", text: "Keep this later body" },
        ]}
      />,
    );
    expect(html).toContain("音频时长超过 10 分钟");
    expect(html).toContain("file:///owned/original.wav");
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("data:audio");
    expect(html).not.toContain("图片内容过于复杂");
    expect(html).not.toContain("重新载入");
    expect(html.indexOf("Original WAV")).toBeLessThan(
      html.indexOf("Following text"),
    );
    expect(html).toContain("Keep this later body");
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it.each([
  ["image/avif", largeAvif()],
  ["audio/wav", wavTestFile({ sampleRate: 1, frames: 601 }).toString("base64")],
])("does not preflight search-only %s media", (mimeType, data) => {
  h.userOpen = false;
  const decode = vi.spyOn(globalThis, "atob");
  try {
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[{ name: "Search-only source", mimeType, data }]}
      />,
    );
    expect(decode).not.toHaveBeenCalled();
    expect(html).toContain("Search-only source");
    expect(html).not.toContain("图片尺寸过大");
    expect(html).not.toContain("音频时长超过");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<audio");
  } finally {
    decode.mockRestore();
  }
});

it("uses audio feedback for a bounded WAVE traversal refusal", () => {
  const data = wavTestFile({
    after: Array.from({ length: 65_535 }, () => ({
      kind: "JUNK",
      data: Buffer.alloc(0),
    })),
  }).toString("base64");
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        { name: "Complex audio", mimeType: "audio/wav", data },
        { name: "Following text", text: "Still retained" },
      ]}
    />,
  );
  expect(html).toContain("音频内容过于复杂");
  expect(html).not.toContain("图片内容过于复杂");
  expect(html).not.toContain("<audio");
  expect(html).not.toContain("data:audio");
  expect(html).toContain("Still retained");
});

it.each([
  ["image/avif", MESSAGE_AVIF_TEST_DATA.STATIC],
  ["audio/wav", MESSAGE_AUDIO_WAV_TEST_DATA],
])(
  "keeps safe %s pending until mount; SSR is not playback proof",
  (mimeType, data) => {
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[{ name: "Safe media", mimeType, data }]}
      />,
    );
    expect(html).toContain("正在准备媒体");
    expect(html).not.toContain("媒体数据格式无法读取");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<audio");
  },
);
