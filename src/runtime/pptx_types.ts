import type { VerifiedFile } from "./file_delivery";

export type PptxFailure =
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
export class PptxError extends Error {
  constructor(readonly code: PptxFailure) {
    super(code);
  }
}
export const PPTX_LIMITS = {
  archive: 16 * 1024 * 1024,
  part: 16 * 1024 * 1024,
  bytes: 64 * 1024 * 1024,
  entries: 2048,
  nodes: 500_000,
  depth: 64,
  text: 4 * 1024 * 1024,
  shapes: 10_000,
  runs: 100_000,
  images: 256,
  imageBytes: 8 * 1024 * 1024,
  imagePixels: 33_554_432,
  wait: 10_000,
} as const;
/** CSS px at 96dpi, including fonts. Positions may be negative. Never clamp. */
export const PPTX_GEOMETRY_LIMITS = {
  slides: 1000,
  slideMin: 1,
  slideMax: 1_000_000,
  slidePixels: 33_554_432,
  coordinate: 1_000_000,
  extent: 1_000_000,
  stroke: 1_000_000,
  fontMin: 0,
  fontMax: 4096,
  inset: 1_000_000,
} as const;
export const PPTX_WARNING_CODES = [
  "fontSubstitution",
  "unsupportedFormatting",
  "unsupportedContent",
  "hiddenContent",
  "hyperlinks",
] as const;
export type PptxWarningCode = (typeof PPTX_WARNING_CODES)[number];
export interface PptxWarning {
  code: PptxWarningCode;
  count: number;
  slideId?: string;
}
export interface PptxCapture {
  file: VerifiedFile;
  parts: { name: string; data: string }[];
  entries: string[];
  inflatedBytes: number;
}
export type PptxWorkerInput = Pick<PptxCapture, "parts" | "entries">;
export interface PptxSource {
  part: string;
  shapeId: string;
  layer: "master" | "layout" | "slide";
}
export interface PptxBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Composed group coordinate mapping; local text, paint and bitmap dimensions
 * remain together, including under nonuniform scaling. No rotation or script. */
export interface PptxGroupTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}
export type PptxShape = (
  | {
      kind: "shape";
      geometry: "rect" | "ellipse" | null;
      fill: string | null;
      stroke: { color: string; width: number } | null;
      text: PptxText | null;
    }
  | { kind: "image"; imageId: string }
) & {
  id: string;
  source: PptxSource;
  box: PptxBox;
  groupTransform?: PptxGroupTransform;
};
export interface PptxText {
  inset: { top: number; right: number; bottom: number; left: number };
  wrap: "none" | "square";
  verticalAlign: "top" | "center" | "bottom";
  paragraphs: PptxParagraph[];
}
export interface PptxParagraph {
  alignment: "left" | "center" | "right";
  runs: PptxRun[];
}
export type PptxRun =
  | {
      kind: "text";
      text: string;
      fontFamily: string;
      fontSize: number;
      color: string;
      bold: boolean;
      italic: boolean;
      underline: boolean;
    }
  | { kind: "break" };
export interface PptxImage {
  id: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  width: number;
  height: number;
}
export interface PptxSlide {
  id: string;
  part: string;
  background: string;
  shapes: PptxShape[];
}
export interface PptxDocument {
  width: number;
  height: number;
  slides: PptxSlide[];
  images: PptxImage[];
  warnings: PptxWarning[];
  partial: boolean;
}
export interface PptxPreview extends PptxDocument {
  file: VerifiedFile;
}
