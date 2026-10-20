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
import { MESSAGE_AUDIO_PREFIX_TEST_DATA as F } from "../runtime/message_audio_prefix_fixtures.test-support";

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

it.each([F.MPEG_LONG_601, F.ADTS_LONG_601])(
  "shows a tagged duration refusal without discarding the following text or original location",
  (data) => {
    const input = {
      name: "Tagged long audio",
      uri: "file:///controlled/original-tagged",
      mimeType: "audio/mpeg",
      data,
    };
    const before = JSON.stringify(input);
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          input,
          { name: "Following", text: "Keep this following text" },
        ]}
      />,
    );
    expect(html).toContain("此音频超过预览处理上限");
    expect(html).toContain(input.uri);
    expect(html).toContain("Keep this following text");
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("data:audio");
    expect(html).not.toContain("重新载入");
    expect(JSON.stringify(input)).toBe(before);
  },
);

it("does not preflight a tagged payload for a search-only expansion", () => {
  h.userOpen = false;
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        {
          name: "Search-only tagged audio",
          mimeType: "audio/mpeg",
          data: F.MPEG_LONG_601,
        },
      ]}
    />,
  );
  expect(html).toContain("Search-only tagged audio");
  expect(html).not.toContain("音频超过预览处理上限");
  expect(html).not.toContain("<audio");
});

it("keeps a known short tagged stream pending an actual mount, without claiming SSR playback", () => {
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        {
          name: "Short tagged audio",
          mimeType: "audio/mpeg",
          data: F.MPEG_SHORT_3,
        },
      ]}
    />,
  );
  expect(html).toContain("正在准备媒体");
  expect(html).not.toContain("媒体数据格式无法读取");
  expect(html).not.toContain("<audio");
});
