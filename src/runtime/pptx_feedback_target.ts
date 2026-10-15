import type { VerifiedFile } from "./file_delivery";
import { validPptxSlide, type PptxSlideAnchor } from "./file_feedback_anchor";
import { samePreviewFile } from "./preview_capture";
import {
  PPTX_LIMITS,
  PPTX_GEOMETRY_LIMITS,
  type PptxPreview,
  type PptxSlide,
} from "./pptx_types";

/** Transient identity only; a saved anchor never creates this identity. */
export type PptxFeedbackSource = Readonly<{
  kind: "pptx";
  file: Readonly<VerifiedFile>;
}>;
export interface PptxFeedbackSourceInput {
  preview: PptxPreview;
  slide: PptxSlide;
  expectedFile: VerifiedFile;
}
const fileKeys = [
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "version",
  "sha256",
] as const;
type Record = {
  input: PptxFeedbackSourceInput;
  file: VerifiedFile;
  slides: PptxSlide[];
  id: string;
  anchor: Readonly<PptxSlideAnchor>;
};
const sources = new WeakMap<PptxFeedbackSource, Record>();
function validFile(file: VerifiedFile): boolean {
  return Boolean(
    file &&
    typeof file === "object" &&
    !Array.isArray(file) &&
    fileKeys.every(
      (key) =>
        key === "size" ||
        (typeof file[key] === "string" && file[key].length > 0),
    ) &&
    /^[a-f0-9]{64}$/i.test(file.sha256) &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    file.size <= PPTX_LIMITS.archive,
  );
}
function coordinates({
  preview,
  slide,
  expectedFile,
}: PptxFeedbackSourceInput): PptxSlideAnchor | null {
  if (
    !preview ||
    !validFile(preview.file) ||
    !validFile(expectedFile) ||
    !samePreviewFile(preview.file, expectedFile) ||
    !Array.isArray(preview.slides) ||
    !preview.slides.length ||
    preview.slides.length > PPTX_GEOMETRY_LIMITS.slides
  )
    return null;
  const parts = new Set<string>(),
    ids = new Set<string>();
  let index = -1;
  for (let at = 0; at < preview.slides.length; at++) {
    const item = preview.slides[at];
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      parts.has(item.part) ||
      !validPptxSlide({
        kind: "pptx-slide",
        part: item.part,
        previewSlide: at + 1,
        previewSlideCount: preview.slides.length,
      })
    )
      return null;
    ids.add(item.id);
    parts.add(item.part);
    if (item === slide) {
      if (index !== -1) return null;
      index = at;
    }
  }
  return index < 0
    ? null
    : {
        kind: "pptx-slide",
        part: slide.part,
        previewSlide: index + 1,
        previewSlideCount: preview.slides.length,
      };
}
export function createPptxFeedbackSource(
  input: PptxFeedbackSourceInput,
): PptxFeedbackSource | null {
  const anchor = coordinates(input);
  if (!anchor) return null;
  const source: PptxFeedbackSource = Object.freeze({
    kind: "pptx",
    file: Object.freeze(
      Object.fromEntries(
        fileKeys.map((key) => [key, input.preview.file[key]]),
      ) as unknown as VerifiedFile,
    ),
  });
  sources.set(source, {
    input: { ...input },
    file: input.preview.file,
    slides: input.preview.slides,
    id: input.slide.id,
    anchor: Object.freeze(anchor),
  });
  return source;
}
export function pptxFeedbackTarget(
  source: PptxFeedbackSource,
): PptxSlideAnchor | null {
  const record = sources.get(source);
  if (!record) return null;
  const now = coordinates(record.input);
  if (
    record.input.preview.file !== record.file ||
    record.input.preview.slides !== record.slides ||
    record.input.slide.id !== record.id ||
    !samePreviewFile(source.file, record.file) ||
    !now ||
    (Object.keys(now) as (keyof PptxSlideAnchor)[]).some(
      (key) => now[key] !== record.anchor[key],
    )
  ) {
    sources.delete(source);
    return null;
  }
  return { ...record.anchor };
}
export function pptxFeedbackSourceIsValid(source: PptxFeedbackSource): boolean {
  return pptxFeedbackTarget(source) !== null;
}
export function retirePptxFeedbackSource(source: PptxFeedbackSource): void {
  sources.delete(source);
}
