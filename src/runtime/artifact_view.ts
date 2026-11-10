import { paneCards, type PaneCard } from "./artifacts";
import type { ThreadState, ToolCallView } from "./session_types";
import {
  NO_STOPPED_TOOL_CALLS,
  unfinishedStoppedToolCallIds,
} from "./stopped_tool_results";

export type FileArtifact = Extract<PaneCard, { kind: "diff" }> & {
  fragment?: { toolCallId: string; number: number };
};
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

type ArtifactFileChoice = { key: string; card: FileArtifact };

// An explicit fragment choice belongs to the current report array. A later
// content update replaces that array and may reuse its path and ordinal.
const reportKeys = new WeakMap<ToolCallView["content"], number>();
let nextReportKey = 0;

function reportKey(content: ToolCallView["content"]): number {
  const existing = reportKeys.get(content);
  if (existing !== undefined) return existing;
  const key = ++nextReportKey;
  reportKeys.set(content, key);
  return key;
}

/** Wider views still group by path. An exact step can report several separate
 * snippets for one path, with no evidence that they are contiguous. */
export function artifactFileChoices(
  cards: PaneCard[],
  step?: ThreadState["items"][number],
): ArtifactFileChoice[] {
  if (step?.kind !== "tool")
    return artifactFiles(cards).map((card) => ({
      key: `file:${card.path}`,
      card,
    }));

  const totals = new Map<string, number>();
  const numbers = new Map<string, number>();
  const reports = cards.filter((card) => card.kind === "diff");
  for (const { path } of reports) totals.set(path, (totals.get(path) ?? 0) + 1);
  return reports.map((card) => {
    const { path } = card;
    if (totals.get(path) === 1) return { key: `file:${path}`, card };
    const number = (numbers.get(path) ?? 0) + 1;
    numbers.set(path, number);
    return {
      key: `fragment:${JSON.stringify([reportKey(step.call.content), path, number])}`,
      card: { ...card, fragment: { toolCallId: step.call.toolCallId, number } },
    };
  });
}

export function canSelectArtifact(
  thread: ThreadState,
  scopeId: string | null,
  selected: string,
): boolean {
  const cards = artifactPaneCards(thread, scopeId);
  if (!cards) return false;
  if (selected === "output") return cards.some((card) => card.kind !== "diff");
  const step = thread.items.find((item) => item.id === scopeId);
  return artifactFileChoices(cards, step).some(
    (choice) => choice.key === selected,
  );
}

/** Resolve only the chosen step or round's existing tool items. A missing boundary
 * after replay is unavailable, never permission to show a different round. */
export function artifactPaneCards(
  thread: ThreadState,
  roundId: string | null,
): PaneCard[] | null {
  if (roundId === null) return paneCards(thread);
  // A selected step/round contains only tool cards. Keep the full conversation
  // as the source of its matched cancellation receipt.
  const selectedCards = (items: ThreadState["items"]) =>
    paneCards({ ...thread, items }, 0, unfinishedStoppedToolCallIds(thread));
  const round = thread.items.find((item) => item.id === roundId);
  if (round?.kind === "tool") return selectedCards([round]);
  if (round?.kind !== "settled" || !round.artifactToolItemIds) return null;
  const ids = new Set(round.artifactToolItemIds);
  const items = thread.items.filter(
    (item) => item.kind === "tool" && ids.has(item.id),
  );
  if (items.length !== ids.size) return null;
  return selectedCards(items);
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
        toolCounts.set(
          id,
          paneCards({ ...thread, items: [tool] }, 0, NO_STOPPED_TOOL_CALLS)
            .length,
        );
      count += toolCounts.get(id)!;
    }
    if (complete) rounds.set(item.id, count);
  }
  return rounds;
}

/** An explicit selection within a step must never fall back to another file. */
export function selectedArtifactFile(
  files: ArtifactFileChoice[],
  selected: string | null,
  exact = false,
): ArtifactFileChoice | null {
  if (selected === "output") return null;
  return (
    files.find(
      ({ key, card }) =>
        key === selected || (exact && `file:${card.path}` === selected),
    ) ?? (exact && selected !== null ? null : (files[0] ?? null))
  );
}
