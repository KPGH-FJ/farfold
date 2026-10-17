import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAttachments } from "./MessageContent";
import { MESSAGE_FLAC_TEST_DATA as F } from "../runtime/message_flac_fixtures.test-support";
import { id3PrefixTestFile } from "../runtime/message_audio_prefix_fixtures.test-support";

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

it("shows tagged FLAC duration feedback and keeps following text and original location", () => {
  const uri = "file:///controlled/tagged-original.flac";
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        {
          name: "Tagged FLAC",
          mimeType: "audio/flac",
          uri,
          data: id3PrefixTestFile(F.LONG_601),
        },
        { name: "Following", text: "Keep following text" },
      ]}
    />,
  );
  expect(html).toContain("音频时长超过 10 分钟");
  expect(html).toContain(uri);
  expect(html).toContain("Keep following text");
  expect(html).not.toContain("<audio");
  expect(html).not.toContain("data:audio");
});

it("does not load or preflight a search-only reveal", () => {
  h.userOpen = false;
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        {
          name: "Tagged FLAC",
          mimeType: "audio/flac",
          data: id3PrefixTestFile(F.LONG_601),
        },
      ]}
    />,
  );
  expect(html).not.toContain("音频时长超过");
  expect(html).not.toContain("<audio");
});
