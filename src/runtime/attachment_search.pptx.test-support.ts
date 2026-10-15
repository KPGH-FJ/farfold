import { vi } from "vitest";
import { setup } from "./attachment_search.test-support";
import { AttachmentSearch } from "./attachment_search";
import {
  attachmentSearchCandidates,
  attachmentSearchSourceCurrent,
} from "./attachment_search_source";
import type { VerifiedFile } from "./file_delivery";
import { pptxDisplayFixture, pptxTestCapture } from "./pptx_display_fixture";
import type { PptxCapture, PptxPreview } from "./pptx_types";

/** Controller transport/model fixtures, not an independent parser oracle. */
export function pptxSetup(
  texts = ["parsed needle tail"],
  plain: string[] = [],
) {
  const h = setup([...texts.map(() => "compressed source"), ...plain]);
  const captures = new Map<string, PptxCapture>(),
    previews = new Map<string, PptxPreview>();
  texts.forEach((text, i) => {
    const item = h.s.items[i];
    if (item.kind !== "user" && item.kind !== "agent") throw Error();
    const path = `/fixture/chosen${i}.pptx`;
    item.attachments![0] = { name: `chosen${i}.pptx`, uri: `file://${path}` };
    const file = {
      ...h.files.get(`/fixture/file${i}.txt`)!,
      path,
      resolvedPath: path,
      name: `chosen${i}.pptx`,
      size: 7091,
      sha256:
        "2926fecb62ab09afb99369d8fddcecb4bb6a0dd46f80e774920ebb619c945acc",
    };
    h.files.set(path, file);
    const capture = { ...pptxTestCapture(), file },
      preview = { ...pptxDisplayFixture(), file };
    const shape = preview.slides[0].shapes[0];
    if (shape.kind !== "shape" || !shape.text) throw Error();
    const run = shape.text.paragraphs[0].runs[0];
    if (run.kind !== "text") throw Error();
    run.text = text;
    captures.set(path, capture);
    previews.set(path, preview);
  });
  const services = {
    ...h.services,
    read: vi.fn(async (f: VerifiedFile) => {
      if (/\.pptx$/i.test(f.path)) throw { code: "unsupported" };
      return h.services.read(f);
    }),
    readPptx: vi.fn(async (f: VerifiedFile) => captures.get(f.path)!),
    parsePptx: vi.fn(async (c: PptxCapture, _signal: AbortSignal) =>
      previews.get(c.file.path)!,
    ),
  };
  let candidates = attachmentSearchCandidates([h.s.key], h.states).candidates;
  const refresh = () =>
    (candidates = attachmentSearchCandidates([h.s.key], h.states).candidates);
  const current = () =>
    candidates.every((c) => attachmentSearchSourceCurrent(c, h.states));
  const capture = captures.values().next().value!;
  return {
    ...h,
    services,
    captures,
    previews,
    capture,
    preview: previews.get(capture.file.path)!,
    file: capture.file,
    candidates,
    refresh,
    current,
    search: new AttachmentSearch(services),
  };
}
