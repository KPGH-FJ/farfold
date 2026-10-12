import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_INPUT_MAX_BYTES,
  DOCUMENT_INPUT_RETAINED_MAX_BYTES,
  parseApprovedDocumentText,
  parseLocalDocumentText,
} from "./document_input_types";
const text = "0 false 中文 😀";
const local = () => ({
  schema: 1,
  format: "docx",
  selection: "read-visible-text",
  source: {
    root: "/fixture",
    path: "/fixture/a.docx",
    resolvedPath: "/fixture/a.docx",
    name: "a.docx",
    size: 1000,
    sha256: "a".repeat(64),
    version: "opaque-version",
  },
  textSha256: createHash("sha256").update(text).digest("hex"),
  utf8Bytes: Buffer.byteLength(text),
  partial: false,
  partialSelected: false,
  warnings: [{ code: "continuousLayout", count: 1 }],
  imageReferences: 0,
});
describe("strict document input snapshots", () => {
  it("preserves selected text and clones all mutable known metadata", () => {
    const value = { text, local: local() },
      parsed = parseApprovedDocumentText(value);
    expect(parsed).toEqual(value);
    value.local.source.path = "/different";
    value.local.warnings[0].count = 8;
    expect(parsed.local?.source.path).toBe("/fixture/a.docx");
    expect(parsed.local?.warnings[0].count).toBe(1);
  });
  it.each([
    undefined,
    {},
    { text },
    { text, local: undefined },
    { text, local: { ...local(), schema: 2 } },
    { text, local: { ...local(), extra: true } },
    {
      text,
      local: {
        ...local(),
        source: { ...local().source, secret: "not metadata" },
      },
    },
    { text, local: { ...local(), utf8Bytes: text.length } },
    { text, local: { ...local(), textSha256: "bad" } },
    {
      text,
      local: { ...local(), warnings: [{ code: "notSupported", count: 1 }] },
    },
    {
      text,
      local: {
        ...local(),
        warnings: [
          { code: "continuousLayout", count: 1 },
          { code: "continuousLayout", count: 1 },
        ],
      },
    },
  ])("rejects incomplete, unknown-format or broken known values", (value) => {
    expect(() => parseApprovedDocumentText(value)).toThrow();
  });
  it("allows unconfirmed partial only as a review value, never an approved snapshot", () => {
    const value = { ...local(), partial: true, partialSelected: false };
    expect(parseLocalDocumentText(value)?.partial).toBe(true);
    expect(() => parseApprovedDocumentText({ text, local: value })).toThrow();
    expect(
      parseApprovedDocumentText({
        text,
        local: { ...value, partialSelected: true },
      }).local?.partialSelected,
    ).toBe(true);
  });
  it("allows retained unknown text beyond the send budget, without inventing source fields", () => {
    const retained = "a".repeat(DOCUMENT_INPUT_MAX_BYTES + 1);
    expect(parseApprovedDocumentText({ text: retained, local: null })).toEqual({
      text: retained,
      local: null,
    });
    expect(parseLocalDocumentText(null)).toBeNull();
    expect(() => parseLocalDocumentText(undefined)).toThrow();
    expect(() =>
      parseApprovedDocumentText({
        text: "a".repeat(DOCUMENT_INPUT_RETAINED_MAX_BYTES + 1),
        local: null,
      }),
    ).toThrow();
  });
  it("measures UTF-8 rather than UTF-16 and rejects lossy surrogate encodings", () => {
    const body = "界".repeat(DOCUMENT_INPUT_MAX_BYTES / 2);
    expect(() =>
      parseApprovedDocumentText({
        text: body,
        local: { ...local(), utf8Bytes: body.length },
      }),
    ).toThrow();
    for (const body of ["\ud800", "\udc00", "a\ud800z"])
      expect(() =>
        parseApprovedDocumentText({ text: body, local: null }),
      ).toThrow();
  });
});
