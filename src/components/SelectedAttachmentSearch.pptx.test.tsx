import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { pptxSetup } from "../runtime/attachment_search.pptx.test-support";
import { ATTACHMENT_SEARCH_STRINGS as S } from "../runtime/attachment_search_strings";
import type { AttachmentSearch } from "../runtime/attachment_search";
vi.mock("../runtime/sessions", () => ({
  threads: { getSnapshot: () => ({ index: [], threads: new Map() }) },
  useThreadsSnapshot: () => ({ index: [], threads: new Map() }),
}));
import { SelectedAttachmentSearch } from "./SelectedAttachmentSearch";

function render(controller: AttachmentSearch, active = true) {
  return renderToStaticMarkup(
    <SelectedAttachmentSearch
      active={active}
      rows={[]}
      query="needle"
      scopeKey="controlled-pptx"
      controller={controller}
    />,
  );
}
const status = (html: string) =>
  html.match(/<div role="status">([\s\S]*?)<\/div>/)?.[1] ?? "";

describe("current PPTX search scope and result presentation", () => {
  it("always exposes partial scope beside counts even for a complete preview model", async () => {
    const h = pptxSetup();
    expect(h.preview.partial).toBe(false);
    await h.search.start("needle", h.candidates, h.current);
    const html = render(h.search);
    expect(status(html)).toContain(S.pptxPartial);
    expect(status(html)).toContain(S.pptxSlides(2));
    expect(html).toContain("预览 1/2 · 对象 1 · 段落 1 · 片段 1");
    expect(html).not.toContain("ppt/slides/slide1.xml");
    expect(html).toContain(S.pptxFormatting);
    expect(html).toContain(S.pptxBarriers);
    expect(html).toContain(S.pptxScope);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("retains a partial no-match explanation without claiming full-file absence", async () => {
    const h = pptxSetup(["other content"]);
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().hits).toHaveLength(0);
    const html = render(h.search);
    expect(status(html)).toContain(S.pptxPartial);
    expect(html).toContain(S.empty);
  });

  it("hides result scope and matches when the search view retires or becomes inactive", async () => {
    const h = pptxSetup();
    await h.search.start("needle", h.candidates, h.current);
    expect(render(h.search, false)).not.toContain(S.pptxPartial);
    expect(render(h.search, false)).not.toContain("<mark>");
    h.search.retire();
    expect(render(h.search)).not.toContain(S.pptxPartial);
    expect(render(h.search)).not.toContain("<mark>");
  });

  it("does not expose stale scope as current after the result's file changes", async () => {
    const h = pptxSetup();
    await h.search.start("needle", h.candidates, h.current);
    h.services.check.mockRejectedValueOnce({ code: "changed" });
    expect(
      await h.search.verifyHit(h.search.snapshot().hits[0], h.current),
    ).toBe(false);
    expect(h.search.snapshot().phase).toBe("stale");
    const html = render(h.search);
    expect(status(html)).not.toContain(S.pptxPartial);
    expect(html).not.toContain("<mark>");
  });

  it("reports unsupported packages without a searched-scope success", async () => {
    const h = pptxSetup();
    h.services.parsePptx.mockRejectedValueOnce({ code: "unsupported" });
    await h.search.start("needle", h.candidates, h.current);
    const html = render(h.search);
    expect(status(html)).not.toContain(S.pptxPartial);
    expect(html).toContain(S.errors.unsupported);
    expect(h.services.read).not.toHaveBeenCalled();
  });
});
