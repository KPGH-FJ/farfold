import type { VerifiedFile, VisualPreview } from "./file_delivery";
import { samePreviewFile } from "./preview_capture";
import {
  validPdfPage,
  validVisualAreaAnchor,
  type ImageAreaAnchor,
  type PdfAreaAnchor,
} from "./file_feedback_anchor";
import {
  validVisualAreaRect,
  type VisualAreaRect,
} from "./visual_area_coordinates";
import {
  MAX_PREVIEW_EDGE,
  MAX_PREVIEW_PIXELS,
  MAX_VISUAL_BYTES,
} from "./visual_preview";

type FrameBase = Readonly<{
  file: Readonly<VerifiedFile>;
  pixelWidth: number;
  pixelHeight: number;
}>;
export type VisualFeedbackFrame =
  | (FrameBase & Readonly<{ kind: "image" }>)
  | (FrameBase & Readonly<{ kind: "pdf"; page: number; pageCount: number }>);
export type VisualAreaFeedbackSource =
  | Readonly<{ kind: "image-area"; file: Readonly<VerifiedFile> }>
  | Readonly<{ kind: "pdf-area"; file: Readonly<VerifiedFile> }>;
export type VisualTargetAvailability = {
  source: VisualAreaFeedbackSource;
  available: boolean;
};
export type VisualTargetConfirmation =
  | {
      source: Extract<VisualAreaFeedbackSource, { kind: "image-area" }>;
      anchor: ImageAreaAnchor;
    }
  | {
      source: Extract<VisualAreaFeedbackSource, { kind: "pdf-area" }>;
      anchor: PdfAreaAnchor;
    };
type FrameInputBase = {
  preview: VisualPreview;
  expectedFile: VerifiedFile;
  drawOwner: object;
  pixelWidth: number;
  pixelHeight: number;
  /** Renderer rechecks actual displayed element, operation and geometry owner. */
  isCurrent: () => boolean;
};
export type VisualFeedbackFrameInput = FrameInputBase &
  (
    | { kind: "image"; page?: never; pageCount?: never }
    | { kind: "pdf"; page: number; pageCount: number }
  );
export interface VisualAreaFeedbackSourceInput {
  frame: VisualFeedbackFrame;
  selection: VisualAreaRect;
  expectedFile: VerifiedFile;
}
interface FrameRecord {
  input: VisualFeedbackFrameInput;
  preview: VisualPreview;
  previewFile: VerifiedFile;
  expectedFile: VerifiedFile;
  data: string;
  mimeType: string;
  isCurrent: () => boolean;
  drawOwner: object;
  source?: VisualAreaFeedbackSource;
  checking?: boolean;
}
interface SourceRecord {
  input: VisualAreaFeedbackSourceInput;
  frame: VisualFeedbackFrame;
  selection: VisualAreaRect;
  expectedFile: VerifiedFile;
  anchor: Readonly<ImageAreaAnchor | PdfAreaAnchor>;
}
const frames = new WeakMap<VisualFeedbackFrame, FrameRecord>();
const owners = new WeakMap<object, VisualFeedbackFrame>();
const sources = new WeakMap<VisualAreaFeedbackSource, SourceRecord>();
const fileKeys = [
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const;
const rectKeys = ["left", "top", "right", "bottom"] as const;
function validFile(file: VerifiedFile): boolean {
  return (
    !!file &&
    typeof file === "object" &&
    !Array.isArray(file) &&
    fileKeys.every(
      (key) =>
        key === "size" ||
        (typeof file[key] === "string" && file[key].length > 0),
    ) &&
    /^[a-f0-9]{64}$/i.test(file.sha256) &&
    Number.isSafeInteger(file.size) &&
    file.size > 0 &&
    file.size <= MAX_VISUAL_BYTES
  );
}
function validInput(input: VisualFeedbackFrameInput): boolean {
  return (
    !!input &&
    validFile(input.preview?.file) &&
    validFile(input.expectedFile) &&
    samePreviewFile(input.preview.file, input.expectedFile) &&
    !!input.drawOwner &&
    typeof input.drawOwner === "object" &&
    typeof input.isCurrent === "function" &&
    Number.isSafeInteger(input.pixelWidth) &&
    Number.isSafeInteger(input.pixelHeight) &&
    input.pixelWidth > 0 &&
    input.pixelHeight > 0 &&
    input.pixelWidth <= MAX_PREVIEW_EDGE &&
    input.pixelHeight <= MAX_PREVIEW_EDGE &&
    input.pixelWidth * input.pixelHeight <= MAX_PREVIEW_PIXELS &&
    typeof input.preview.data === "string" &&
    input.preview.data.length > 0 &&
    input.preview.data.length <= Math.ceil(MAX_VISUAL_BYTES / 3) * 4 &&
    (input.kind === "pdf"
      ? input.preview.mimeType === "application/pdf" &&
        validPdfPage(input.page, input.pageCount)
      : input.kind === "image" &&
        input.page === undefined &&
        input.pageCount === undefined &&
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          input.preview.mimeType,
        ))
  );
}

export function retireVisualAreaFeedbackSource(
  source: VisualAreaFeedbackSource,
): void {
  const record = sources.get(source);
  sources.delete(source);
  if (record) {
    const frame = frames.get(record.frame);
    if (frame?.source === source) frame.source = undefined;
  }
}
export function retireVisualFeedbackFrame(frame: VisualFeedbackFrame): void {
  const record = frames.get(frame);
  frames.delete(frame);
  if (!record) return;
  if (record.source) retireVisualAreaFeedbackSource(record.source);
  if (owners.get(record.drawOwner) === frame) owners.delete(record.drawOwner);
}
function currentFrame(frame: VisualFeedbackFrame): FrameRecord | null {
  const r = frames.get(frame);
  if (!r || r.checking) return null;
  try {
    r.checking = true;
    const rendererCurrent = r.isCurrent() === true;
    r.checking = false;
    const i = r.input;
    if (
      rendererCurrent &&
      frames.get(frame) === r &&
      owners.get(r.drawOwner) === frame &&
      i.drawOwner === r.drawOwner &&
      i.isCurrent === r.isCurrent &&
      i.preview === r.preview &&
      r.preview.file === r.previewFile &&
      i.expectedFile === r.expectedFile &&
      r.preview.data === r.data &&
      r.preview.mimeType === r.mimeType &&
      validInput(i) &&
      samePreviewFile(frame.file, r.previewFile) &&
      samePreviewFile(frame.file, r.expectedFile) &&
      i.kind === frame.kind &&
      i.pixelWidth === frame.pixelWidth &&
      i.pixelHeight === frame.pixelHeight &&
      (i.kind !== "pdf" ||
        (frame.kind === "pdf" &&
          i.page === frame.page &&
          i.pageCount === frame.pageCount))
    )
      return r;
  } catch {
    /* A lost renderer owner is not an executable callback retry. */
  } finally {
    r.checking = false;
  }
  retireVisualFeedbackFrame(frame);
  return null;
}

/** Called only by the renderer after accepted image load or actual canvas draw.
 * This stores references, not decoded pixels or a second content ledger. */
export function registerVisualFeedbackFrame(
  input: VisualFeedbackFrameInput,
): VisualFeedbackFrame | null {
  if (!validInput(input)) return null;
  const prior = owners.get(input.drawOwner);
  if (prior) retireVisualFeedbackFrame(prior);
  const file = Object.freeze({ ...input.preview.file });
  const frame: VisualFeedbackFrame = Object.freeze(
    input.kind === "pdf"
      ? {
          kind: "pdf",
          file,
          pixelWidth: input.pixelWidth,
          pixelHeight: input.pixelHeight,
          page: input.page,
          pageCount: input.pageCount,
        }
      : {
          kind: "image",
          file,
          pixelWidth: input.pixelWidth,
          pixelHeight: input.pixelHeight,
        },
  );
  frames.set(frame, {
    input,
    preview: input.preview,
    previewFile: input.preview.file,
    expectedFile: input.expectedFile,
    data: input.preview.data,
    mimeType: input.preview.mimeType,
    isCurrent: input.isCurrent,
    drawOwner: input.drawOwner,
  });
  owners.set(input.drawOwner, frame);
  return currentFrame(frame) ? frame : null;
}

export function createVisualAreaFeedbackSource(
  input: VisualAreaFeedbackSourceInput,
): VisualAreaFeedbackSource | null {
  if (
    !input ||
    !validVisualAreaRect(input.selection) ||
    !validFile(input.expectedFile)
  )
    return null;
  const r = currentFrame(input.frame);
  if (!r || !samePreviewFile(input.frame.file, input.expectedFile)) return null;
  if (r.source) retireVisualAreaFeedbackSource(r.source);
  const frame = input.frame;
  const anchor = Object.freeze(
    frame.kind === "pdf"
      ? {
          kind: "pdf-area" as const,
          space: "display-oriented-v1" as const,
          page: frame.page,
          pageCount: frame.pageCount,
          ...input.selection,
        }
      : {
          kind: "image-area" as const,
          space: "display-oriented-v1" as const,
          ...input.selection,
        },
  );
  const source: VisualAreaFeedbackSource = Object.freeze({
    kind: anchor.kind,
    file: frame.file,
  });
  sources.set(source, {
    input,
    frame,
    selection: input.selection,
    expectedFile: input.expectedFile,
    anchor,
  });
  r.source = source;
  return visualAreaFeedbackSourceIsValid(source) ? source : null;
}

export function visualAreaFeedbackSourceIsValid(
  source: VisualAreaFeedbackSource,
): boolean {
  const r = sources.get(source);
  if (!r) return false;
  const frame = currentFrame(r.frame);
  if (
    frame &&
    sources.get(source) === r &&
    frame.source === source &&
    r.input.frame === r.frame &&
    r.input.selection === r.selection &&
    r.input.expectedFile === r.expectedFile &&
    validFile(r.expectedFile) &&
    samePreviewFile(source.file, r.expectedFile) &&
    validVisualAreaRect(r.selection) &&
    rectKeys.every((key) => r.selection[key] === r.anchor[key])
  )
    return true;
  retireVisualAreaFeedbackSource(source);
  return false;
}
export function visualAreaFeedbackTarget(
  source: VisualAreaFeedbackSource,
): ImageAreaAnchor | PdfAreaAnchor | null {
  if (!visualAreaFeedbackSourceIsValid(source)) return null;
  return { ...sources.get(source)!.anchor };
}
export function visualAreaFeedbackTargetMatches(
  value: VisualTargetConfirmation,
  expectedPreview: VisualPreview,
): boolean {
  const source = value?.source;
  const anchor = value?.anchor;
  if (
    !value ||
    !validVisualAreaAnchor(anchor) ||
    !visualAreaFeedbackSourceIsValid(source)
  )
    return false;
  // Renderer callbacks can synchronously retire/replace input and ownership.
  if (
    value.source !== source ||
    value.anchor !== anchor ||
    !validVisualAreaAnchor(anchor)
  )
    return false;
  const r = sources.get(source);
  if (!r) return false;
  const frame = frames.get(r.frame);
  return (
    frame?.preview === expectedPreview &&
    source.kind === anchor.kind &&
    Object.keys(r.anchor).every(
      (key) =>
        r.anchor[key as keyof typeof r.anchor] ===
        anchor[key as keyof typeof anchor],
    )
  );
}
