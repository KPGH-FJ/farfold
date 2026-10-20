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
import { MESSAGE_MP4_AUDIO_TEST_DATA as F } from "../runtime/message_mp4_audio_fixtures.test-support";

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

it("shows the complete long MP4 refusal while retaining original location and following text", () => {
  const attachment = {
    name: "Long MP4",
    uri: "file:///owned/original-long.m4a",
    mimeType: "audio/mp4",
    data: F.LONG_601,
  };
  const before = JSON.stringify(attachment);
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        attachment,
        { name: "Following text", text: "Retain the following content" },
      ]}
    />,
  );
  expect(html).toContain("此音频超过预览处理上限");
  expect(html).toContain(attachment.uri);
  expect(html).toContain("Retain the following content");
  expect(html).not.toContain("<audio");
  expect(html).not.toContain("data:audio");
  expect(html).not.toContain("重新载入");
  expect(JSON.stringify(attachment)).toBe(before);
});
it("does not preflight MP4 during a search-only expansion", () => {
  h.userOpen = false;
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        { name: "Search-only MP4", mimeType: "audio/mp4", data: F.LONG_601 },
      ]}
    />,
  );
  expect(html).toContain("Search-only MP4");
  expect(html).not.toContain("音频超过预览处理上限");
  expect(html).not.toContain("<audio");
});
it("keeps the short complete control pending a real mount, without SSR playback claims", () => {
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        { name: "Short MP4", mimeType: "audio/mp4", data: F.SHORT_3 },
      ]}
    />,
  );
  expect(html).toContain("正在准备媒体");
  expect(html).not.toContain("媒体数据格式无法读取");
  expect(html).not.toContain("<audio");
});
