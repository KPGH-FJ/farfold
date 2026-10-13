import { vi } from "vitest";
import { setup } from "./attachment_search.test-support";
import { AttachmentSearch } from "./attachment_search";
import {
  attachmentSearchCandidates,
  attachmentSearchSourceCurrent,
} from "./attachment_search_source";
import type { VerifiedFile } from "./file_delivery";
import type { WorkbookCapture } from "./xlsx_types";
import type { XlsxInputCell, XlsxInputResult } from "./xlsx_input_types";

export function searchCell(
  text: string,
  extra: Partial<XlsxInputCell> = {},
): XlsxInputCell {
  return {
    reference: "A1",
    row: 1,
    column: 1,
    styleId: 0,
    type: "inlineStr",
    rawValue: null,
    text,
    runs: [],
    formula: null,
    cacheState: "notFormula",
    visibility: "visible",
    included: true,
    covered: false,
    display: text,
    displayKnown: true,
    ...extra,
  };
}
export function searchWorkbook(
  cells = [searchCell("author needle tail")],
): XlsxInputResult {
  return {
    date1904: false,
    sheets: [{ id: "sheet1", name: "Author sheet", state: "visible" }],
    scope: { mode: "visible-saved-cells", sheetIds: ["sheet1"] },
    selectedSheets: [
      { id: "sheet1", cells, merges: [], protection: "inactive" },
    ],
    partial: false,
    warnings: [],
  };
}
export function xlsxSetup(
  texts = ["author needle tail"],
  plain: string[] = [],
) {
  const h = setup([...texts.map(() => "compressed source"), ...plain]);
  const captures = new Map<string, WorkbookCapture>(),
    results = new Map<string, XlsxInputResult>();
  texts.forEach((text, i) => {
    const item = h.s.items[i];
    if (item.kind !== "user" && item.kind !== "agent") throw Error();
    const path = `/fixture/chosen${i}.xlsx`;
    item.attachments![0] = { name: `chosen${i}.xlsx`, uri: `file://${path}` };
    const file = {
      ...h.files.get(`/fixture/file${i}.txt`)!,
      path,
      resolvedPath: path,
      name: `chosen${i}.xlsx`,
    };
    h.files.set(path, file);
    captures.set(path, {
      file,
      parts: [{ name: "xl/workbook.xml", data: "eA==" }],
      entries: ["xl/workbook.xml"],
      inflatedBytes: 1,
    });
    results.set(path, searchWorkbook([searchCell(text)]));
  });
  const services = {
    ...h.services,
    readWorkbook: vi.fn(async (file: VerifiedFile) => captures.get(file.path)!),
    parseWorkbook: vi.fn(
      async (capture: WorkbookCapture, _signal: AbortSignal) =>
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
    workbook: results.get(capture.file.path)!,
    candidates,
    refresh,
    current,
    search: new AttachmentSearch(services),
  };
}
