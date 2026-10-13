import { paneCards, type PaneCard } from "./artifacts";
import type { ThreadState } from "./session_types";

export type FileArtifact = Extract<PaneCard, { kind: "diff" }>;
import type { DiffLine } from "./line_diff";
export type { DiffLine } from "./line_diff";

export interface SplitDiffLine {
  before: DiffLine | null;
  after: DiffLine | null;
}

/** Pair only changed runs; unchanged lines remain aligned at their actual locations. */
export function splitDiffRows(rows: DiffLine[]): SplitDiffLine[] {
  const result: SplitDiffLine[] = [];
  let before: DiffLine[] = [],
    after: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(before.length, after.length); i++)
      result.push({ before: before[i] ?? null, after: after[i] ?? null });
    before = [];
    after = [];
  };
  for (const row of rows) {
    if (row.kind === "same") {
      flush();
      result.push({ before: row, after: row });
    } else if (row.kind === "uncompared") {
      flush();
      result.push({
        before: row.oldLine === null ? null : row,
        after: row.newLine === null ? null : row,
      });
    } else if (row.kind === "remove") before.push(row);
    else after.push(row);
  }
  flush();
  return result;
}

export function filePresentation(
  card: FileArtifact,
): "code" | "markdown" | "html" {
  if (/\.(md|markdown|mdown)$/i.test(card.path)) return "markdown";
  if (/\.html?$/i.test(card.path)) return "html";
  return "code";
}

/** Preview the returned document, not the file on disk. HTML structure does not
 * establish full-file contents or absolute line coordinates. */
export function canPreviewHtml(card: FileArtifact): boolean {
  const markup = card.newText
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  return (
    card.source === "diff" &&
    filePresentation(card) === "html" &&
    /<html(?:\s|>)/i.test(markup) &&
    /<\/html\s*>/i.test(markup) &&
    /<head(?:\s|>)/i.test(markup) &&
    /<\/head\s*>/i.test(markup) &&
    /<body(?:\s|>)/i.test(markup) &&
    /<\/body\s*>/i.test(markup)
  );
}

export const STATIC_PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";

/** No script, same-origin, form, popup or top-navigation permission is granted. */
export const STATIC_PREVIEW_SANDBOX = "";

/** CSP is first and cannot be loosened by markup. Remove self-navigation too. */
export function staticPreviewDocument(html: string): string {
  const content = html
    .replace(/<meta\b[^>]*>/gi, " ")
    .replace(/<base\b[^>]*>/gi, " ")
    .replace(/[\s/](?:xlink:)?href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, " ");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${STATIC_PREVIEW_CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}</body></html>`;
}

/** Select the latest report for each path without reading current disk state. */
export function artifactFiles(cards: PaneCard[]): FileArtifact[] {
  const files = new Map<string, FileArtifact>();
  for (const card of cards)
    if (card.kind === "diff") files.set(card.path, card);
  return [...files.values()];
}

/** Resolve only the chosen step or round's existing tool items. A missing boundary
 * after replay is unavailable, never permission to show a different round. */
export function artifactPaneCards(
  thread: ThreadState,
  roundId: string | null,
): PaneCard[] | null {
  if (roundId === null) return paneCards(thread);
  const round = thread.items.find((item) => item.id === roundId);
  if (round?.kind === "tool") return paneCards({ ...thread, items: [round] });
  if (round?.kind !== "settled" || !round.artifactToolItemIds) return null;
  const ids = new Set(round.artifactToolItemIds);
  const items = thread.items.filter(
    (item) => item.kind === "tool" && ids.has(item.id),
  );
  if (items.length !== ids.size) return null;
  return paneCards({ ...thread, items });
}

/** Refresh displayed counts from the same references as navigation, including
 * late tool output after stop. Each referenced tool is counted only once. */
export function artifactRoundCounts(thread: ThreadState): Map<string, number> {
  const items = new Map(thread.items.map((item) => [item.id, item]));
  const toolCounts = new Map<string, number>();
  const rounds = new Map<string, number>();
  for (const item of thread.items) {
    if (item.kind !== "settled" || !item.artifactToolItemIds) continue;
    let count = 0;
    let complete = true;
    for (const id of item.artifactToolItemIds) {
      const tool = items.get(id);
      if (tool?.kind !== "tool") {
        complete = false;
        break;
      }
      if (!toolCounts.has(id))
        toolCounts.set(id, paneCards({ ...thread, items: [tool] }).length);
      count += toolCounts.get(id)!;
    }
    if (complete) rounds.set(item.id, count);
  }
  return rounds;
}

/** Prefix path values so a literal file named output cannot select the log view. */
export function selectedArtifactFile(
  files: FileArtifact[],
  selected: string | null,
): FileArtifact | null {
  if (selected === "output") return null;
  return (
    files.find((card) => `file:${card.path}` === selected) ?? files[0] ?? null
  );
}
