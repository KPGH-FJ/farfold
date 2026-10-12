import type { VerifiedFile } from "./file_delivery";

export type DocxFailure =
  | "invalid"
  | "unsupported"
  | "limit"
  | "encrypted"
  | "changed"
  | "unreadable"
  | "readPending"
  | "readBusy"
  | "cancelled"
  | "timeout"
  | "busy";
export class DocxError extends Error {
  constructor(readonly code: DocxFailure) {
    super(code);
  }
}
export const DOCX_LIMITS = {
  archive: 16 * 1024 * 1024,
  bytes: 64 * 1024 * 1024,
  part: 16 * 1024 * 1024,
  entries: 2048,
  nodes: 500_000,
  depth: 64,
  text: 4 * 1024 * 1024,
  blocks: 10_000,
  runs: 100_000,
  cells: 20_000,
  tableColumns: 512,
  tableDepth: 8,
  styles: 4096,
  images: 256,
  imageBytes: 8 * 1024 * 1024,
  imagePixels: 33_554_432,
  wait: 10_000,
} as const;
export const DOCX_WARNING_CODES = [
  "continuousLayout",
  "fontSubstitution",
  "unsupportedFormatting",
  "hyperlinks",
  "cachedFields",
  "missingFieldResult",
  "hiddenContent",
  "externalImages",
  "missingImage",
  "unsupportedImage",
  "unsupportedDrawing",
  "unsupportedContent",
  "sectionLayout",
  "comments",
  "listFormat",
] as const;
export type DocxWarningCode = (typeof DOCX_WARNING_CODES)[number];
export interface DocxWarning {
  code: DocxWarningCode;
  count: number;
}
export interface DocxCapture {
  file: VerifiedFile;
  parts: { name: string; data: string }[];
  entries: string[];
  inflatedBytes: number;
}
export type DocxWorkerInput = Pick<DocxCapture, "parts" | "entries">;
/** A closed style vocabulary. Never raw document CSS, HTML, or URLs. */
export interface DocxTextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: "single" | "double" | "none";
  color?: string;
  background?: string;
  fontSizePt?: number;
  verticalAlign?: "baseline" | "superscript" | "subscript";
}
export interface DocxParagraphStyle {
  alignment?: "left" | "center" | "right" | "justify";
  leftPt?: number;
  rightPt?: number;
  firstLinePt?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineHeight?: number;
}
export type DocxRun =
  | { kind: "text"; text: string; style: DocxTextStyle }
  | {
      kind: "noteReference";
      noteKind: "footnote" | "endnote";
      noteId: string;
      style: DocxTextStyle;
    }
  | { kind: "break"; page?: boolean }
  | { kind: "tab" }
  | {
      kind: "image";
      imageId: string;
      widthPt: number;
      heightPt: number;
      alt: string;
    }
  | { kind: "notice"; code: DocxWarningCode };
export interface DocxSourcePosition {
  readonly part: string;
  readonly elementPath: readonly number[];
}
export interface DocxParagraph {
  kind: "paragraph";
  id: string;
  source: DocxSourcePosition;
  runs: DocxRun[];
  style: DocxParagraphStyle;
  headingLevel?: number;
  list?: { label: string; level: number };
}
export interface DocxBorder {
  color: string;
  widthPt: number;
  style: "solid" | "dashed" | "dotted" | "double";
}
export interface DocxCell {
  blocks: DocxBlock[];
  column: number;
  rowSpan: number;
  columnSpan: number;
  widthPt?: number;
  background?: string;
  verticalAlign?: "top" | "center" | "bottom";
  borders?: Partial<Record<"top" | "right" | "bottom" | "left", DocxBorder>>;
}
export interface DocxTable {
  kind: "table";
  id: string;
  source: DocxSourcePosition;
  columnsPt: number[];
  rows: { cells: DocxCell[] }[];
}
export type DocxBlock =
  | DocxParagraph
  | DocxTable
  | { kind: "notice"; id: string; code: DocxWarningCode };
export interface DocxStory {
  id: string;
  kind: "header" | "footer" | "footnote" | "endnote";
  /** Literal source ID for notes; not a computed Word page number. */
  noteId?: string;
  blocks: DocxBlock[];
}
export interface DocxImage {
  id: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  width: number;
  height: number;
}
export interface DocxDocument {
  blocks: DocxBlock[];
  stories: DocxStory[];
  images: DocxImage[];
  warnings: DocxWarning[];
  /** True when visible content has an explicit omitted/unsupported placeholder. */
  partial: boolean;
}
export interface DocxPreview extends DocxDocument {
  file: VerifiedFile;
}
