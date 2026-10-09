/** Authored fixture builder: no user documents or file/Agent access. */
import type { XlsxWorkerInput } from "./xlsx_types";
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/package/2006/relationships";
export function xmlBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
export const fixtureStyles = `<styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="[h]:mm"/></numFmts><fonts count="1"><font><name val="Arial"/><sz val="11"/><b/><color rgb="FF112233"/></font></fonts><fills count="1"><fill><patternFill patternType="solid"><fgColor rgb="FFEEDDCC"/></patternFill></fill></fills><borders count="1"><border><bottom style="thin"><color rgb="FF000000"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;
export function workbookFixture(
  rows: string,
  options: {
    date1904?: boolean;
    extra?: string;
    before?: string;
    strings?: string;
    styles?: string;
  } = {},
): XlsxWorkerInput {
  const texts: Record<string, string> = {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${P}"><Relationship Id="office" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${NS}" xmlns:r="${R}"><workbookPr date1904="${options.date1904 ? 1 : 0}"/><sheets><sheet name="样本" sheetId="1" r:id="sheet1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${P}"><Relationship Id="sheet1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/>${options.strings !== undefined ? `<Relationship Id="strings" Type="${R}/sharedStrings" Target="sharedStrings.xml"/>` : ""}</Relationships>`,
    "xl/styles.xml": options.styles ?? fixtureStyles,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${NS}">${options.before ?? ""}<sheetData>${rows}</sheetData>${options.extra ?? ""}</worksheet>`,
  };
  if (options.strings !== undefined)
    texts["xl/sharedStrings.xml"] =
      `<sst xmlns="${NS}">${options.strings}</sst>`;
  return {
    parts: Object.entries(texts).map(([name, text]) => ({
      name,
      data: xmlBase64(text),
    })),
    entries: Object.keys(texts),
  };
}
export function replacePart(
  input: XlsxWorkerInput,
  name: string,
  replace: (xml: string) => string,
): XlsxWorkerInput {
  return {
    ...input,
    parts: input.parts.map((p) =>
      p.name === name
        ? {
            ...p,
            data: xmlBase64(
              replace(
                new TextDecoder().decode(
                  Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0)),
                ),
              ),
            ),
          }
        : p,
    ),
  };
}
