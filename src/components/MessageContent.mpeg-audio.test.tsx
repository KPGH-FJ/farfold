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
import { MESSAGE_MPEG_AUDIO_TEST_DATA as F } from "../runtime/message_mpeg_audio_admission_fixtures.test-support";

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

it.each(["audio/mp3", "audio/wav"])(
  "renders long MPEG refusal under %s before creating an audio source",
  (mimeType) => {
    const input = {
      name: "Original long MP3",
      uri: "file:///controlled/original.mp3",
      data: F.LONG_601,
      mimeType,
    };
    const before = JSON.stringify(input);
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          input,
          { name: "Following", text: "Keep following text" },
        ]}
      />,
    );
    expect(html).toContain("此音频超过预览处理上限");
    expect(html).toContain(input.uri);
    expect(html).toContain("Keep following text");
    expect(html).not.toContain("data:audio");
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("重新载入");
    expect(JSON.stringify(input)).toBe(before);
  },
);

it("does not preflight a long MPEG payload merely revealed by search", () => {
  h.userOpen = false;
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        { name: "Search only", mimeType: "audio/mpeg", data: F.LONG_601 },
      ]}
    />,
  );
  expect(html).toContain("Search only");
  expect(html).not.toContain("音频超过预览处理上限");
  expect(html).not.toContain("<audio");
});

it("admits the complete short MPEG fixture pending a mount without claiming SSR playback", () => {
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        { name: "Short MP3", mimeType: "audio/mpeg", data: F.TINY },
      ]}
    />,
  );
  expect(html).toContain("正在准备媒体");
  expect(html).not.toContain("媒体数据格式无法读取");
  expect(html).not.toContain("<audio");
});
