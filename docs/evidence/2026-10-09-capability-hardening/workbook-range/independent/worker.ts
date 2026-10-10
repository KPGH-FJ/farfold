import captures from "./capture-data.json";
import oracle from "../fixtures/oracle.json";
import { readWorkbookPreview } from "/src/runtime/xlsx_preview";
import { parseWorkbook } from "/src/runtime/xlsx_parse";
import {
  analyzeWorkbookFeedbackRange,
  parseWorkbookFeedbackRange,
} from "/src/runtime/workbook_feedback_range";
import {
  createWorkbookRangeFeedbackSource,
  workbookFeedbackTarget,
  retireWorkbookFeedbackSource,
} from "/src/runtime/workbook_feedback_target";
(window as any).probe = async () => {
  const checks: any[] = [],
    outputs: any[] = [];
  const check = (name: string, pass: boolean, detail?: unknown) => {
    checks.push({ name, pass, detail });
    if (!pass) throw Error(name);
  };
  for (const f of oracle.files) {
    const c = (captures as any)[f.file];
    const capture = {
      ...c,
      file: {
        root: "/controlled",
        path: "/controlled/current.xlsx",
        resolvedPath: "/controlled/current.xlsx",
        name: "current.xlsx",
        size: c.bytes,
        sha256: c.sha256,
        version: "controlled:" + f.file,
      },
    };
    for (const o of f.sheets) {
      try {
        const w = await readWorkbookPreview(
          capture,
          o.relationshipId,
          new AbortController().signal,
        );
        outputs.push({ file: f.file, sheet: o.name, preview: w });
        check(
          f.file + ":" + o.name + ":actual sheet relation identity",
          w.sheet?.id === o.relationshipId &&
            w.sheets.find((s) => s.id === o.relationshipId)?.name === o.name,
        );
        check(
          "merges from independent XML",
          JSON.stringify(w.sheet!.merges) ===
            JSON.stringify(Object.values(o.merges)),
        );
        for (const a of ["A2", "B2", "F2"]) {
          const e = (o.cells as any)[a];
          const cell = w.sheet!.cells.find(
            (c) => c.row === e.row && c.column === e.column,
          );
          check(
            a + " typed nonempty value retained",
            cell?.value ===
              (e.type === "b" ? e.rawValue === "1" : Number(e.rawValue)),
            cell,
          );
        }
        for (const r of o.ranges) {
          const range = parseWorkbookFeedbackRange(r.input);
          check(
            "parse literal " + r.input,
            JSON.stringify(range) === JSON.stringify(r.normalized),
          );
          const analysis = analyzeWorkbookFeedbackRange({
            preview: w,
            range: range!,
          });
          check("analysis exists", !!analysis);
          check(
            "partial merge oracle " + r.input,
            JSON.stringify(analysis!.partialMerges) ===
              JSON.stringify(r.partialMerges.map((m) => (o.merges as any)[m])),
          );
          const rows = analysis!.hiddenRows.flatMap((x) =>
            Array.from({ length: x.to - x.from + 1 }, (_, i) => x.from + i),
          );
          const cols = analysis!.hiddenColumns.flatMap((x) =>
            Array.from({ length: x.to - x.from + 1 }, (_, i) => x.from + i),
          );
          check(
            "hidden rows oracle " + r.input,
            JSON.stringify(rows) === JSON.stringify(r.hiddenRowsIntersecting),
          );
          const expectedCols = r.hiddenColumnsIntersecting.flatMap((x) =>
            Array.from({ length: x.max - x.min + 1 }, (_, i) => x.min + i),
          );
          check(
            "hidden columns oracle " + r.input,
            JSON.stringify(cols) === JSON.stringify(expectedCols),
            { cols, expectedCols },
          );
          const input = {
            capture,
            preview: w,
            analysis: analysis!,
            expectedFile: capture.file,
            hiddenSheetSelected: false,
            selection: { ...range!, includeHidden: false },
          };
          const source = createWorkbookRangeFeedbackSource(input);
          check(
            "hidden gate " + r.input,
            analysis!.requiresHiddenConfirmation ? source === null : !!source,
          );
          const accepted =
            source ??
            createWorkbookRangeFeedbackSource({
              ...input,
              selection: { ...range!, includeHidden: true },
            });
          check(
            "exact source target " + r.input,
            JSON.stringify(workbookFeedbackTarget(accepted!)) ===
              JSON.stringify({
                kind: "xlsx-range",
                sheetId: o.relationshipId,
                sheetName: o.name,
                ...range!,
              }),
          );
          retireWorkbookFeedbackSource(accepted!);
          check(
            "retired source unusable",
            workbookFeedbackTarget(accepted!) === null,
          );
        }
      } catch (e) {
        let diagnostic: unknown;
        try {
          parseWorkbook({
            parts: capture.parts,
            entries: capture.entries,
            sheetId: o.relationshipId,
          });
        } catch (d) {
          diagnostic = {
            error: String(d),
            stack: d instanceof Error ? d.stack : undefined,
          };
        }
        outputs.push({
          file: f.file,
          sheet: o.name,
          error: String(e),
          diagnostic,
        });
        return { passed: false, checks, outputs };
      }
    }
  }
  return { passed: checks.every((x) => x.pass), checks, outputs };
};
