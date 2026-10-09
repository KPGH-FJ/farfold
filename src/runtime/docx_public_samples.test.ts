import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docxFixture } from "./docx_fixture";
import { parseDocx } from "./docx_parse";
import { checkedDocxDocument } from "./docx_validation";
const source = JSON.parse(
  readFileSync(
    new URL(
      "../../docs/evidence/2026-10-09-capability-hardening/docx/public-samples/provenance.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
describe("unchanged maintainer-published DOCX samples", () => {
  for (const sample of source.files)
    it(sample.file, () => {
      const result = checkedDocxDocument(
        parseDocx(
          docxFixture(
            sample.file.replace(/\.docx$/, ""),
            "docx/public-samples",
          ),
        ),
      );
      for (const text of sample.sourceTextNodes)
        expect(JSON.stringify(result.blocks)).toContain(text);
      if (sample.file === "tiny-picture.docx")
        expect(result.images.length).toBe(1);
      if (sample.file === "footnotes.docx")
        expect(result.stories.length).toBeGreaterThan(0);
      if (sample.file === "simple-list.docx")
        expect(
          result.blocks
            .filter((b) => b.kind === "paragraph")
            .every((b) => b.list),
        ).toBe(true);
    });
});
