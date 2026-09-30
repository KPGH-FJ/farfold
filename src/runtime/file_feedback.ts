import type { FileFeedback } from "./drafts";

export type FeedbackSelection = NonNullable<FileFeedback["selection"]>;

export function selectionInput(selection: FeedbackSelection | null): string {
  if (!selection) return "";
  return `${selection.line}${selection.endLine && selection.endLine !== selection.line ? `–${selection.endLine}` : ""}`;
}

/** Coordinates only refer to the exact displayed side, never a disk file. */
export function parseFeedbackSelection(
  text: string,
  side: FeedbackSelection["side"],
  lineCount: number,
): FeedbackSelection | null {
  const match = /^(\d+)(?:\s*[-–—−]\s*(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const line = Number(match[1]);
  const endLine = match[2] ? Number(match[2]) : line;
  if (
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(endLine) ||
    line < 1 ||
    endLine < line ||
    endLine > lineCount
  )
    return null;
  return { side, line, ...(endLine !== line ? { endLine } : {}) };
}

export function isSelectedLine(
  selection: FeedbackSelection | null | undefined,
  side: FeedbackSelection["side"],
  line: number | null,
): boolean {
  return Boolean(
    selection &&
    line !== null &&
    selection.side === side &&
    line >= selection.line &&
    line <= (selection.endLine ?? selection.line),
  );
}
