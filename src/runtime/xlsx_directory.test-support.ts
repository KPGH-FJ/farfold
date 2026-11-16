import { replacePart, workbookFixture, xmlBase64 } from "./xlsx_fixture";
import type { XlsxWorkerInput } from "./xlsx_types";

/** Authored package parts: valid global metadata, broken first sheet only. */
export function firstSheetFailureFixture(): XlsxWorkerInput {
  let input = workbookFixture('<row r="1"><c r="A1"><v>42</v></c></row>');
  const validSheet = input.parts.find(
    (part) => part.name === "xl/worksheets/sheet1.xml",
  )!;
  input = replacePart(input, "xl/workbook.xml", (xml) =>
    xml.replace(
      "</sheets>",
      '<sheet name="Good second sheet" sheetId="2" r:id="sheet2"/></sheets>',
    ),
  );
  input = replacePart(input, "xl/_rels/workbook.xml.rels", (xml) =>
    xml.replace(
      "</Relationships>",
      '<Relationship Id="sheet2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
  );
  input = replacePart(input, "xl/worksheets/sheet1.xml", () => "<worksheet>");
  const name = "xl/worksheets/sheet2.xml";
  return {
    ...input,
    entries: [...input.entries, name],
    parts: [...input.parts, { name, data: validSheet.data }],
  };
}

export function corruptGlobalStyles(input: XlsxWorkerInput): XlsxWorkerInput {
  return {
    ...input,
    parts: input.parts.map((part) =>
      part.name === "xl/styles.xml"
        ? { ...part, data: xmlBase64("<styleSheet>") }
        : part,
    ),
  };
}
