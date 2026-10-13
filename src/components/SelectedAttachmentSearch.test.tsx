import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AttachmentSearch } from "../runtime/attachment_search";
import { setup } from "../runtime/attachment_search.test-support";
import {
  attachmentSearchCandidates,
  attachmentSearchSourceCurrent,
} from "../runtime/attachment_search_source";
import { ATTACHMENT_SEARCH_STRINGS as S } from "../runtime/attachment_search_strings";
import type { DocxCapture } from "../runtime/docx_types";
vi.mock("../runtime/sessions", () => ({
  threads: { getSnapshot: () => ({ index: [], threads: new Map() }) },
  useThreadsSnapshot: () => ({ index: [], threads: new Map() }),
}));
import { SelectedAttachmentSearch } from "./SelectedAttachmentSearch";

async function searched(partial: boolean) {
  const h = setup(["needle"]),
    item = h.s.items[0];
  if (item.kind !== "user") throw Error();
  item.attachments[0].mimeType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const file = h.files.values().next().value!;
  const candidates = attachmentSearchCandidates([h.s.key], h.states).candidates;
  const current = () =>
    candidates.every((c) => attachmentSearchSourceCurrent(c, h.states));
  const search = new AttachmentSearch({
    ...h.services,
    readDocx: async () => ({ file, parts: [], entries: [], inflatedBytes: 1 }),
    parseDocx: async (_capture: DocxCapture) => ({
      file,
      blocks: [
        {
          kind: "paragraph",
          id: "p",
          source: { part: "word/document.xml", elementPath: [0, 0] },
          style: {},
          runs: [{ kind: "text", text: "needle", style: {} }],
        },
      ],
      stories: [],
      images: [],
      warnings: [],
      partial,
    }),
  });
  await search.start("needle", candidates, current);
  return { search, services: h.services, current };
}
function render(controller: AttachmentSearch, active = true) {
  return renderToStaticMarkup(
    <SelectedAttachmentSearch
      active={active}
      rows={[]}
      query="needle"
      scopeKey="controlled"
      controller={controller}
    />,
  );
}
function status(html: string) {
  return html.match(/<div role="status">([\s\S]*?)<\/div>/)?.[1] ?? "";
}

describe("selected attachment omitted-content notice", () => {
  it("shows the partial scope beside counts even while per-file details are closed", async () => {
    const { search } = await searched(true);
    const html = render(search);
    expect(status(html)).toContain(S.docxPartial);
    expect(html).toMatch(/<details class="history-search-coverage">/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html.slice(html.indexOf("<details"))).toContain(S.docxPartial);
  });
  it("does not invent omissions when the searched content has none", async () => {
    const { search } = await searched(false);
    expect(render(search)).not.toContain(S.docxPartial);
  });
  it("does not expose old partial results when the search view is inactive or retired", async () => {
    const { search } = await searched(true);
    expect(render(search, false)).not.toContain(S.docxPartial);
    search.retire();
    expect(render(search)).not.toContain(S.docxPartial);
  });
  it("does not keep a current-scope notice after result ownership becomes stale", async () => {
    const h = await searched(true);
    h.services.check.mockRejectedValue({ code: "changed" });
    expect(
      await h.search.verifyHit(h.search.snapshot().hits[0], h.current),
    ).toBe(false);
    expect(h.search.snapshot().phase).toBe("stale");
    expect(h.search.snapshot().rows[0].document?.partial).toBe(true);
    expect(status(render(h.search))).not.toContain(S.docxPartial);
  });
});
