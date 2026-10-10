import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docxFixture } from "./docx_fixture";
import { parseDocx } from "./docx_parse";
import { checkedDocxDocument } from "./docx_validation";
import type { DocxBlock, DocxParagraph } from "./docx_types";
const expected = JSON.parse(
  readFileSync(
    new URL(
      "../../docs/evidence/2026-10-09-capability-hardening/docx-compatibility/expectations.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function text(blocks: DocxBlock[]): string[] {
  return blocks.flatMap((b): string[] =>
    b.kind === "paragraph"
      ? [b.runs.map((r) => (r.kind === "text" ? r.text : "")).join("")]
      : b.kind === "table"
        ? b.rows.flatMap((r) => r.cells.flatMap((c) => text(c.blocks)))
        : [],
  );
}
describe("independent python-docx writer compatibility", () => {
  for (const sample of expected.samples)
    it(sample.file, () => {
      const capture = docxFixture(
        sample.file.replace(/\.docx$/, ""),
        "docx-compatibility",
      );
      const document = parseDocx(capture);
      checkedDocxDocument(document, new Set(capture.parts.map((p) => p.name)));
      const strings = text(document.blocks);
      if (sample.requiredBodyTextInOrder)
        expect(strings.filter(Boolean)).toEqual(sample.requiredBodyTextInOrder);
      if (sample.requiredText)
        for (const expectedText of sample.requiredText)
          expect(strings).toContain(expectedText);
      if (sample.emptyParagraphs)
        expect(strings.filter((s) => s === "").length).toBe(
          sample.emptyParagraphs,
        );
      if (sample.numberedItems) {
        const p = document.blocks.filter(
          (p): p is DocxParagraph =>
            p.kind === "paragraph" &&
            sample.numberedItems.includes(text([p])[0]),
        );
        expect(p.map((p) => p.list?.label)).toEqual(sample.numberLabels);
      }
      if (sample.bulletItems)
        for (const b of document.blocks)
          if (
            b.kind === "paragraph" &&
            sample.bulletItems.includes(text([b])[0])
          )
            expect(b.list?.label).toBe("•");
      if (sample.directRunFormatting)
        for (const [word, property] of Object.entries(
          sample.directRunFormatting,
        )) {
          const runs = document.blocks.flatMap((b) =>
            b.kind === "paragraph" ? b.runs : [],
          );
          expect(
            runs.some(
              (r) =>
                r.kind === "text" &&
                r.text === word &&
                r.style[property as "bold" | "italic"] === true,
            ),
          ).toBe(true);
        }
      if (sample.tables) {
        const table = document.blocks.find((b) => b.kind === "table")!;
        if (table.kind !== "table") throw Error("table missing");
        expect(table.rows).toHaveLength(4);
        expect(table.columnsPt).toHaveLength(3);
        expect(
          table.rows[0].cells.find((c) => c.column === 0)?.columnSpan,
        ).toBe(2);
        expect(table.rows[1].cells.find((c) => c.column === 0)?.rowSpan).toBe(
          2,
        );
        expect(
          text(table.rows[2].cells.find((c) => c.column === 1)!.blocks),
        ).toEqual([""]);
      }
      if (sample.header)
        expect(
          document.stories
            .filter((s) => s.kind === "header")
            .flatMap((s) => text(s.blocks)),
        ).toContain(sample.header);
      if (sample.footer)
        expect(
          document.stories
            .filter((s) => s.kind === "footer")
            .flatMap((s) => text(s.blocks)),
        ).toContain(sample.footer);
      if (sample.images)
        expect(
          document.images.map((i) => [i.width, i.height, i.mimeType]),
        ).toEqual(
          sample.images.map(
            (i: { width: number; height: number; mime: string }) => [
              i.width,
              i.height,
              i.mime,
            ],
          ),
        );
      const storyText = document.stories.flatMap((s) => text(s.blocks));
      for (const line of [
        sample.header,
        sample.footer,
        ...(sample.headers ?? []),
        ...(sample.footers ?? []),
      ].filter(Boolean))
        expect(storyText).toContain(line);
    });
});
