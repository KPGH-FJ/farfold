import { createHash } from "node:crypto";
import { vi } from "vitest";
import { setup } from "./attachment_search.test-support";
import { AttachmentSearch } from "./attachment_search";
import {
  attachmentSearchCandidates,
  attachmentSearchSourceCurrent,
} from "./attachment_search_source";
import type { VerifiedFile } from "./file_delivery";
import {
  PDF_INPUT_SCOPE_WARNING_CODES,
  type PdfInputCapture,
  type PdfInputResult,
} from "./pdf_input_types";

export function searchPdf(pages = [["author needle tail"]]): PdfInputResult {
  return {
    scope: {
      mode: "decoded-page-text",
      includePossiblyInvisibleText: true,
      pageCount: pages.length,
      readPageNumbers: pages.map((_, i) => i + 1),
      extraction: "pdfjs-text-content-v1",
    },
    pages: pages.map((texts, i) => ({
      number: i + 1,
      decodedRotation: i % 2 ? 90 : 0,
      items: texts.map((text) => ({ text, dir: "ltr", hasEOL: false })),
    })),
    partial: true,
    warnings: [
      ...PDF_INPUT_SCOPE_WARNING_CODES.map((code) => ({
        code,
        count: 1 as const,
        unit: "scope" as const,
      })),
      ...(pages.filter((p) => !p.some((t) => /\S/u.test(t))).length
        ? [
            {
              code: "pagesWithoutText" as const,
              count: pages.filter((p) => !p.some((t) => /\S/u.test(t))).length,
              unit: "pages" as const,
            },
          ]
        : []),
    ],
  };
}
export function pdfSetup(texts = ["author needle tail"], plain: string[] = []) {
  // Controller fixtures use real hashed whole capture bytes, but a controlled
  // parser result. They do not claim these bytes are a structurally valid PDF.
  const h = setup([...texts.map(() => "%PDF-controlled-capture"), ...plain]);
  const captures = new Map<string, PdfInputCapture>(),
    results = new Map<string, PdfInputResult>();
  texts.forEach((text, i) => {
    const item = h.s.items[i];
    if (item.kind !== "user" && item.kind !== "agent") throw Error();
    const path = `/fixture/chosen${i}.pdf`;
    item.attachments![0] = { name: `chosen${i}.pdf`, uri: `file://${path}` };
    const raw = Buffer.from(`%PDF-controlled-capture-${i}`);
    const file = {
      ...h.files.get(`/fixture/file${i}.txt`)!,
      path,
      resolvedPath: path,
      name: `chosen${i}.pdf`,
      size: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
    h.files.set(path, file);
    captures.set(path, { file, data: raw.toString("base64") });
    results.set(path, searchPdf([[text]]));
  });
  const services = {
    ...h.services,
    readPdf: vi.fn(async (file: VerifiedFile) => captures.get(file.path)!),
    parsePdf: vi.fn(async (capture: PdfInputCapture, _signal: AbortSignal) =>
      results.get(capture.file.path)!,
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
    results,
    capture,
    file: capture.file,
    pdf: results.get(capture.file.path)!,
    candidates,
    refresh,
    current,
    search: new AttachmentSearch(services),
  };
}
