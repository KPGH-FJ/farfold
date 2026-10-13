import { expect, it } from "vitest";
import { documentMediaFormat } from "./document_media_type";

it.each([
  ["application/pdf", "pdf"],
  ["Application/PDF", "pdf"],
  ["application/pdf;version=1.7", "pdf"],
  [" \tAPPLICATION/PDF \t; arbitrary=unchanged", "pdf"],
  [
    "Application/Vnd.Openxmlformats-Officedocument.Wordprocessingml.Document;version=1",
    "docx",
  ],
  [
    "APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.SPREADSHEETML.SHEET;version=1",
    "xlsx",
  ],
])(
  "identifies %s without rewriting its value or granting authority",
  (value, format) => {
    const before = value;
    expect(documentMediaFormat(value)).toBe(format);
    expect(value).toBe(before);
  },
);

it.each([
  undefined,
  null,
  {},
  "",
  "application/pdfx",
  "application/pdf\r\n",
  "application /pdf",
  "\u0085application/pdf",
  "application/octet-stream",
  "text/plain",
  "__proto__",
])("does not guess a document format from %j", (value) => {
  expect(documentMediaFormat(value)).toBeUndefined();
});
