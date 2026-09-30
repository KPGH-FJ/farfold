import { paneCards, type PaneCard } from "./artifacts";
import type { ThreadState } from "./session_types";

export type FileArtifact = Extract<PaneCard, { kind: "diff" }>;
export interface DiffLine {
  kind: "same" | "remove" | "add";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

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
    } else if (row.kind === "remove") before.push(row);
    else after.push(row);
  }
  flush();
  return result;
}

/** Bounded line alignment; large unrelated middles fall back to exact replace rows. */
export function lineDiff(before: string | null, after: string): DiffLine[] {
  const old = before === null || before === "" ? [] : before.split("\n");
  const next = after === "" ? [] : after.split("\n");
  const rows: DiffLine[] = [];
  let prefix = 0;
  while (
    prefix < Math.min(old.length, next.length) &&
    old[prefix] === next[prefix]
  ) {
    rows.push({
      kind: "same",
      oldLine: prefix + 1,
      newLine: prefix + 1,
      text: old[prefix],
    });
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < Math.min(old.length, next.length) - prefix &&
    old[old.length - suffix - 1] === next[next.length - suffix - 1]
  )
    suffix++;
  const a = old.slice(prefix, old.length - suffix),
    b = next.slice(prefix, next.length - suffix);
  const removed = (i: number) =>
    rows.push({
      kind: "remove",
      oldLine: prefix + i + 1,
      newLine: null,
      text: a[i],
    });
  const added = (j: number) =>
    rows.push({
      kind: "add",
      oldLine: null,
      newLine: prefix + j + 1,
      text: b[j],
    });
  if ((a.length + 1) * (b.length + 1) <= 1_000_000) {
    const cols = b.length + 1;
    const table = new Uint32Array((a.length + 1) * cols);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        table[i * cols + j] =
          a[i] === b[j]
            ? table[(i + 1) * cols + j + 1] + 1
            : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    let i = 0,
      j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        rows.push({
          kind: "same",
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
          text: a[i],
        });
        i++;
        j++;
      } else if (
        j >= b.length ||
        (i < a.length && table[(i + 1) * cols + j] >= table[i * cols + j + 1])
      ) {
        removed(i++);
      } else {
        added(j++);
      }
    }
  } else {
    a.forEach((_, i) => removed(i));
    b.forEach((_, j) => added(j));
  }
  for (let i = suffix; i > 0; i--)
    rows.push({
      kind: "same",
      oldLine: old.length - i + 1,
      newLine: next.length - i + 1,
      text: next[next.length - i],
    });
  return rows;
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
