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
import { MESSAGE_ADTS_TEST_DATA } from "../runtime/message_adts_fixtures.test-support";

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

it.each(["audio/aac", "audio/mpeg"])(
  "shows the duration refusal for actual long ADTS AAC under %s without a source",
  (mimeType) => {
    const attachment = {
      name: "Original long ADTS AAC",
      uri: "file:///owned/original.aac",
      mimeType,
      data: MESSAGE_ADTS_TEST_DATA.LONG_601,
    };
    const before = JSON.stringify(attachment);
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          attachment,
          { name: "Following text", text: "Keep this body after the audio" },
        ]}
      />,
    );
    expect(html).toContain("此音频超过预览处理上限");
    expect(html).toContain("file:///owned/original.aac");
    expect(html).toContain("Keep this body after the audio");
    expect(html.indexOf("Original long ADTS AAC")).toBeLessThan(
      html.indexOf("Following text"),
    );
    expect(html).not.toContain("data:audio");
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("重新载入");
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it("does not preflight long ADTS AAC during a search-only reveal", () => {
  h.userOpen = false;
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        {
          name: "Search-only ADTS AAC",
          mimeType: "audio/aac",
          data: MESSAGE_ADTS_TEST_DATA.LONG_601,
        },
      ]}
    />,
  );
  expect(html).toContain("Search-only ADTS AAC");
  expect(html).not.toContain("音频超过预览处理上限");
  expect(html).not.toContain("data:audio");
  expect(html).not.toContain("<audio");
});

it("keeps an admitted short ADTS AAC pending until mount; SSR proves no playback", () => {
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        {
          name: "Short complete ADTS AAC",
          mimeType: "audio/aac",
          data: MESSAGE_ADTS_TEST_DATA.TINY,
        },
      ]}
    />,
  );
  expect(html).toContain("正在准备媒体");
  expect(html).not.toContain("媒体数据格式无法读取");
  expect(html).not.toContain("<audio");
});
