import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAttachments } from "./MessageContent";
import { PNG_IMAGE_TEST_DATA } from "../runtime/image_fixtures.test-support";
import { MESSAGE_RASTER_TEST_DATA as F } from "../runtime/message_raster_fixtures.test-support";
import { AUDIO_FIXTURE_DATA } from "../runtime/audio_input.test-support";

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

it("shows an explicit malformed-media explanation without creating a media element", () => {
  const attachment = {
    kind: "image" as const,
    name: "Original name",
    uri: "file:///owned/image.png",
    data: "Zg",
    mimeType: "image/png",
  };
  const before = JSON.stringify(attachment);
  const html = renderToStaticMarkup(
    <MessageAttachments attachments={[attachment]} />,
  );
  expect(html.includes("<img")).toBe(false);
  expect(html.includes("<audio")).toBe(false);
  expect(html).toContain("媒体数据格式无法读取");
  expect(html).toContain("Original name");
  expect(html).toContain("file:///owned/image.png");
  expect(html).not.toContain("重新载入");
  expect(JSON.stringify(attachment)).toBe(before);
});

it("shows the 16 MiB boundary and preserves later text attachments in order", () => {
  const data = "A".repeat(4 * Math.ceil((16 * 1024 * 1024) / 3) + 4);
  const attachment = {
    kind: "audio" as const,
    name: "Original audio",
    data,
    mimeType: "audio/wav",
  };
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        attachment,
        { name: "After media", text: "Retained next body" },
      ]}
    />,
  );
  expect(html.includes("<audio")).toBe(false);
  expect(html.includes("data:audio")).toBe(false);
  expect(html).toContain("16 MiB");
  expect(html.indexOf("Original audio")).toBeLessThan(
    html.indexOf("After media"),
  );
  expect(html).toContain("Retained next body");
  expect(attachment.data === data).toBe(true);
});

it("does not admit or reject media merely because search revealed its text", () => {
  h.userOpen = false;
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        { name: "Search-only image", data: "Zg", mimeType: "image/png" },
      ]}
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("媒体数据格式无法读取");
  expect(html).toContain("Search-only image");
});

it("does not acquire media before mounting and preserves explicit remote links", () => {
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        { name: "Exact PNG", data: PNG_IMAGE_TEST_DATA, mimeType: "image/png" },
        { name: "Audio", data: AUDIO_FIXTURE_DATA, mimeType: "audio/wav" },
        {
          name: "Remote",
          uri: "https://example.com/remote.png",
          mimeType: "image/png",
        },
      ]}
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<audio");
  expect(html).not.toContain("data:image/png");
  expect(html).toContain("Exact PNG");
  expect(html).toContain("Audio");
  expect(html.match(/正在准备媒体…/g)).toHaveLength(2);
  expect(html).not.toMatch(/autoplay/i);
  expect(html).not.toContain('src="https://');
  expect(html).toContain('href="https://example.com/remote.png"');
});

// Real small-PNG bytes with only IHDR changed and CRC recomputed; never decode
// this large declared canvas. SSR proves refusal markup, not mounted resources.
const largePng =
  "iVBORw0KGgoAAAANSUhEUgAAIAEAAAABCAIAAAAW69wJAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC";

it.each(["image/png", "image/jpeg"])(
  "preserves source and order when a PNG canvas is refused under %s",
  (mimeType) => {
    const attachment = {
      name: "Original canvas",
      uri: "file:///owned/canvas.png",
      mimeType,
      data: largePng,
    };
    const before = JSON.stringify(attachment);
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          attachment,
          { name: "After canvas", text: "Following body" },
        ]}
      />,
    );
    expect(html).toContain("图片尺寸过大");
    expect(html).toContain("file:///owned/canvas.png");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("正在准备媒体");
    expect(html).not.toContain("重新载入");
    expect(html.indexOf("Original canvas")).toBeLessThan(
      html.indexOf("After canvas"),
    );
    expect(html).toContain("Following body");
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it("does not inspect the PNG header for a search-only expansion", () => {
  h.userOpen = false;
  const atob = vi.spyOn(globalThis, "atob");
  try {
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          { name: "Search canvas", mimeType: "image/png", data: largePng },
        ]}
      />,
    );
    expect(atob).not.toHaveBeenCalled();
    expect(html).not.toContain("图片尺寸过大");
    expect(html).not.toContain("<img");
    expect(html).toContain("Search canvas");
  } finally {
    atob.mockRestore();
  }
});

it("shows a complexity refusal before media admission without losing following content", () => {
  const original = Buffer.from(F.GIF, "base64");
  const imageStart = original.indexOf(0x2c, 13);
  if (imageStart < 0) throw new Error("owned fixture missing image");
  const data = Buffer.concat([
    original.subarray(0, imageStart),
    ...Array.from({ length: 129 }, () => original.subarray(imageStart, -1)),
    Buffer.from([0x3b]),
  ]).toString("base64");
  const attachment = {
    name: "Original animation",
    uri: "file:///owned/source.gif",
    mimeType: "image/gif",
    data,
  };
  const before = JSON.stringify(attachment);
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        attachment,
        { name: "After animation", text: "Following body" },
      ]}
    />,
  );
  expect(html).toContain("图片内容过于复杂");
  expect(html).toContain("file:///owned/source.gif");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("data:image");
  expect(html).not.toContain("正在准备媒体");
  expect(html).not.toContain("重新载入");
  expect(html.indexOf("Original animation")).toBeLessThan(
    html.indexOf("After animation"),
  );
  expect(html).toContain("Following body");
  expect(JSON.stringify(attachment)).toBe(before);
});

it("leaves a search-only animated attachment uninspected until explicit expansion", () => {
  h.userOpen = false;
  const decode = vi.spyOn(globalThis, "atob");
  try {
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          {
            name: "Search animation",
            mimeType: "image/gif",
            data: F.GIF_ANIMATED,
          },
        ]}
      />,
    );
    expect(decode).not.toHaveBeenCalled();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("图片内容过于复杂");
    expect(html).not.toContain("正在准备媒体");
    expect(html).toContain("Search animation");
  } finally {
    decode.mockRestore();
  }
});
