import {
  DOCX_LIMITS as L,
  type DocxBlock,
  type DocxParagraph,
  type DocxPreview,
  type DocxSourcePosition,
  type DocxTable,
} from "./docx_types";
import { isDocxSourcePosition } from "./docx_source_position";
import type { VerifiedFile } from "./file_delivery";
import { validDocxBlock, type DocxBlockAnchor } from "./file_feedback_anchor";
import { samePreviewFile } from "./preview_capture";

/** Ephemeral identity, never persisted with an opinion. */
export type DocumentFeedbackSource = Readonly<{
  kind: "docx";
  file: Readonly<VerifiedFile>;
}>;
export interface DocumentFeedbackSourceInput {
  preview: DocxPreview;
  block: DocxParagraph | DocxTable;
  expectedFile: VerifiedFile;
}
interface SourceRecord {
  input: DocumentFeedbackSourceInput;
  previewFile: VerifiedFile;
  position: DocxSourcePosition;
  path: readonly number[];
  anchor: Readonly<DocxBlockAnchor>;
}
const sources = new WeakMap<DocumentFeedbackSource, SourceRecord>();
const fileKeys = [
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const;

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
    file.size >= 0 &&
    file.size <= L.archive
  );
}
function samePosition(a: DocxSourcePosition, b: DocxSourcePosition): boolean {
  return (
    a.part === b.part &&
    a.elementPath.length === b.elementPath.length &&
    a.elementPath.every((v, i) => v === b.elementPath[i])
  );
}
function eligibleParagraph(block: DocxParagraph): boolean {
  if (!Array.isArray(block.runs) || block.runs.length > L.runs) return false;
  // Empty source paragraphs remain visible structural targets. Omission-only
  // paragraphs do not prove that the hidden/unsupported content was displayed.
  return (
    !block.runs.some((run) => run.kind === "notice") ||
    block.runs.some(
      (run) =>
        (run.kind === "text" && run.text.length > 0) ||
        run.kind === "noteReference" ||
        run.kind === "image" ||
        run.kind === "break" ||
        run.kind === "tab",
    )
  );
}

/** Display eligibility only; does not establish preview membership or live ownership. */
export function documentFeedbackBlockIsEligible(
  block: DocxBlock,
): block is DocxParagraph | DocxTable {
  return (
    block?.kind === "table" ||
    (block?.kind === "paragraph" && eligibleParagraph(block))
  );
}

/** Membership is by actual block reference, never display id/text equality.
 * The bounded walk also rejects duplicated/mutated coordinates and cycles. */
function member(
  preview: DocxPreview,
  target: DocxParagraph | DocxTable,
): boolean {
  if (
    !Array.isArray(preview.blocks) ||
    !Array.isArray(preview.stories) ||
    preview.stories.length > L.blocks
  )
    return false;
  const seen = new Set<DocxBlock>();
  let blocks = 0,
    cells = 0,
    matches = 0,
    coordinates = 0;
  const walk = (list: DocxBlock[], depth: number): boolean => {
    if (!Array.isArray(list) || list.length > L.blocks) return false;
    for (const item of list) {
      if (!item || seen.has(item) || ++blocks > L.blocks) return false;
      seen.add(item);
      if (item.kind === "notice") continue;
      if (
        (item.kind !== "paragraph" && item.kind !== "table") ||
        !isDocxSourcePosition(item.source)
      )
        return false;
      if (item === target) matches++;
      if (samePosition(item.source, target.source)) coordinates++;
      if (item.kind === "table") {
        if (
          depth >= L.tableDepth ||
          !Array.isArray(item.rows) ||
          item.rows.length > L.cells
        )
          return false;
        for (const row of item.rows) {
          if (!Array.isArray(row.cells) || row.cells.length > L.tableColumns)
            return false;
          for (const cell of row.cells) {
            if (++cells > L.cells || !walk(cell.blocks, depth + 1))
              return false;
          }
        }
      }
    }
    return true;
  };
  if (!walk(preview.blocks, 0)) return false;
  for (const story of preview.stories)
    if (!story || !walk(story.blocks, 0)) return false;
  return matches === 1 && coordinates === 1;
}

function coordinates(
  input: DocumentFeedbackSourceInput,
): DocxBlockAnchor | null {
  const { preview, block, expectedFile } = input;
  if (
    !preview ||
    !validFile(preview.file) ||
    !validFile(expectedFile) ||
    !samePreviewFile(preview.file, expectedFile) ||
    !block ||
    !documentFeedbackBlockIsEligible(block) ||
    !isDocxSourcePosition(block.source) ||
    !member(preview, block)
  )
    return null;
  const anchor: DocxBlockAnchor = {
    kind: "docx-block",
    part: block.source.part,
    elementPath: [...block.source.elementPath],
    blockKind: block.kind,
  };
  return validDocxBlock(anchor) ? anchor : null;
}

/** Supply the exact successful preview and currently displayed source block.
 * This validates receipt relationships, not disk authenticity or DOM visibility.
 * The component must retire it on story/fragment/window/owner changes. */
export function createDocumentFeedbackSource(
  input: DocumentFeedbackSourceInput,
): DocumentFeedbackSource | null {
  const anchor = coordinates(input);
  if (!anchor) return null;
  const source: DocumentFeedbackSource = Object.freeze({
    kind: "docx",
    file: Object.freeze(
      Object.fromEntries(
        fileKeys.map((key) => [key, input.preview.file[key]]),
      ) as unknown as VerifiedFile,
    ),
  });
  sources.set(source, {
    input: { ...input },
    previewFile: input.preview.file,
    position: input.block.source,
    path: input.block.source.elementPath,
    anchor: Object.freeze({
      ...anchor,
      elementPath: Object.freeze([...anchor.elementPath]),
    }),
  });
  return source;
}

export function documentFeedbackTarget(
  source: DocumentFeedbackSource,
): DocxBlockAnchor | null {
  const record = sources.get(source);
  if (
    !record ||
    record.input.preview.file !== record.previewFile ||
    record.input.block.source !== record.position ||
    record.position.elementPath !== record.path ||
    !samePreviewFile(source.file, record.previewFile) ||
    !samePreviewFile(source.file, record.input.expectedFile)
  )
    return null;
  const current = coordinates(record.input);
  return current &&
    current.blockKind === record.anchor.blockKind &&
    samePosition(current, record.anchor)
    ? { ...record.anchor, elementPath: [...record.anchor.elementPath] }
    : null;
}
export function documentFeedbackSourceIsValid(
  source: DocumentFeedbackSource,
): boolean {
  return documentFeedbackTarget(source) !== null;
}
/** Permanent for this exact identity; repeated retirement is harmless. */
export function retireDocumentFeedbackSource(
  source: DocumentFeedbackSource,
): void {
  sources.delete(source);
}
