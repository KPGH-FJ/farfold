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
import {
  apngTestFile,
  MESSAGE_APNG_TEST_DATA,
} from "../runtime/message_apng_fixtures.test-support";

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

it.each(["image/png", "image/apng"])(
  "renders %s APNG feedback and preserves source order",
  (mimeType) => {
    const attachment = {
      name: "Original animation",
      data: apngTestFile({ frames: 129 }).toString("base64"),
      mimeType,
      uri: "file:///owned/animation.png",
    };
    const before = JSON.stringify(attachment);
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          attachment,
          { name: "Following source", text: "Retained after animation" },
        ]}
      />,
    );
    expect(html).toContain("图片内容过于复杂");
    expect(html).toContain("file:///owned/animation.png");
    expect(html.indexOf("Original animation")).toBeLessThan(
      html.indexOf("Following source"),
    );
    expect(html).toContain("Retained after animation");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:image");
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it.each(["image/png", "image/apng"])(
  "does not inspect %s when search only reveals attachment text",
  (mimeType) => {
    h.userOpen = false;
    const atob = vi.spyOn(globalThis, "atob");
    try {
      const html = renderToStaticMarkup(
        <MessageAttachments
          attachments={[
            {
              name: "Search-only animation",
              data: apngTestFile({ frames: 129 }).toString("base64"),
              mimeType,
            },
          ]}
        />,
      );
      expect(atob).not.toHaveBeenCalled();
      expect(html).toContain("Search-only animation");
      expect(html).not.toContain("图片内容过于复杂");
      expect(html).not.toContain("<img");
    } finally {
      atob.mockRestore();
    }
  },
);

it.each(["image/png", "image/apng"])(
  "keeps budgeted %s; SSR is not mounted playback proof",
  (mimeType) => {
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          {
            name: "Budgeted animation",
            data: MESSAGE_APNG_TEST_DATA,
            mimeType,
          },
        ]}
      />,
    );
    expect(html).toContain("Budgeted animation");
    expect(html).not.toContain("图片内容过于复杂");
    expect(html).not.toContain("媒体数据格式无法读取");
    // Shared leases are acquired after mounting, not by server-side rendering.
    expect(html).not.toContain("<img");
  },
);

it("reports a broken APNG control without turning it into a supported source", () => {
  const data = Buffer.from(MESSAGE_APNG_TEST_DATA, "base64");
  data[49] ^= 1;
  const html = renderToStaticMarkup(
    <MessageAttachments
      attachments={[
        {
          name: "Broken animation",
          data: data.toString("base64"),
          mimeType: "image/png",
        },
      ]}
    />,
  );
  expect(html).toContain("媒体数据格式无法读取");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("data:image");
});
