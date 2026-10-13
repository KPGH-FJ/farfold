/** Comparison is a view of supplied text, never evidence about the file on disk. */
export const DIFF_LIMITS = {
  characters: 2 * 1024 * 1024,
  lines: 20_000,
  cells: 1_000_000,
} as const;

export type LineEnding = "none" | "LF" | "CRLF";
export interface TextLine {
  text: string;
  ending: LineEnding;
}
export interface DiffLine {
  kind: "same" | "remove" | "add" | "uncompared";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}
export interface EndingChange {
  oldLine: number;
  newLine: number;
  before: LineEnding;
  after: LineEnding;
}
export interface LineComparison {
  precision: "aligned" | "replacement" | "missing-before" | "unavailable";
  rows: DiffLine[];
  stats: { adds: number; removes: number } | null;
  endingChanges: EndingChange[];
  reason?: "characters" | "lines";
}

/** LF-delimited physical rows, without a phantom row after the final LF.
 * A lone CR is body text. limit bounds allocation, not the original payload. */
export function textLines(text: string, limit = Infinity): TextLine[] {
  const rows: TextLine[] = [];
  let start = 0;
  while (start < text.length && rows.length < limit) {
    const lf = text.indexOf("\n", start);
    if (lf < 0) {
      rows.push({ text: text.slice(start), ending: "none" });
      break;
    }
    const crlf = lf > start && text[lf - 1] === "\r";
    rows.push({
      text: text.slice(start, crlf ? lf - 1 : lf),
      ending: crlf ? "CRLF" : "LF",
    });
    start = lf + 1;
  }
  return rows;
}

export function textLineCount(text: string): number {
  if (!text) return 0;
  let count = text.endsWith("\n") ? 0 : 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1))
    count++;
  return count;
}

export function compareLines(
  before: string | null,
  after: string,
): LineComparison {
  const unavailable = (reason: "characters" | "lines"): LineComparison => ({
    precision: "unavailable",
    rows: [],
    stats: null,
    endingChanges: [],
    reason,
  });
  if ((before?.length ?? 0) + after.length > DIFF_LIMITS.characters)
    return unavailable("characters");
  const old = textLines(before ?? "", DIFF_LIMITS.lines + 1);
  const next = textLines(
    after,
    DIFF_LIMITS.lines + 1 - Math.min(old.length, DIFF_LIMITS.lines),
  );
  if (old.length + next.length > DIFF_LIMITS.lines) return unavailable("lines");
  if (before === null)
    return {
      precision: "missing-before",
      rows: next.map((line, i) => ({
        kind: "uncompared",
        oldLine: null,
        newLine: i + 1,
        text: line.text,
      })),
      stats: null,
      endingChanges: [],
    };

  // Exact string interning bounds the LCS inner loop to integer comparisons;
  // no hash-only equality and no repeated comparison of long line prefixes.
  const ids = new Map<string, number>();
  const intern = (line: TextLine) => {
    let id = ids.get(line.text);
    if (id === undefined) {
      id = ids.size;
      ids.set(line.text, id);
    }
    return id;
  };
  const a = old.map(intern),
    b = next.map(intern);
  const rows: DiffLine[] = [];
  const endingChanges: EndingChange[] = [];
  const same = (i: number, j: number) => {
    rows.push({
      kind: "same",
      oldLine: i + 1,
      newLine: j + 1,
      text: old[i].text,
    });
    if (old[i].ending !== next[j].ending)
      endingChanges.push({
        oldLine: i + 1,
        newLine: j + 1,
        before: old[i].ending,
        after: next[j].ending,
      });
  };
  const remove = (i: number) =>
    rows.push({
      kind: "remove",
      oldLine: i + 1,
      newLine: null,
      text: old[i].text,
    });
  const add = (j: number) =>
    rows.push({
      kind: "add",
      oldLine: null,
      newLine: j + 1,
      text: next[j].text,
    });
  let prefix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) {
    same(prefix, prefix);
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const n = a.length - prefix - suffix,
    m = b.length - prefix - suffix;
  const aligned = n === 0 || m === 0 || (n + 1) * (m + 1) <= DIFF_LIMITS.cells;
  if (n === 0 || m === 0 || !aligned) {
    for (let i = 0; i < n; i++) remove(prefix + i);
    for (let j = 0; j < m; j++) add(prefix + j);
  } else {
    const cols = m + 1;
    const table = new Uint32Array((n + 1) * cols);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i * cols + j] =
          a[prefix + i] === b[prefix + j]
            ? table[(i + 1) * cols + j + 1] + 1
            : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j])
        same(prefix + i++, prefix + j++);
      else if (
        j >= m ||
        (i < n && table[(i + 1) * cols + j] >= table[i * cols + j + 1])
      )
        remove(prefix + i++);
      else add(prefix + j++);
    }
  }
  for (let k = suffix; k > 0; k--) same(a.length - k, b.length - k);
  return {
    precision: aligned ? "aligned" : "replacement",
    rows,
    endingChanges,
    stats: aligned
      ? {
          adds: rows.filter((r) => r.kind === "add").length,
          removes: rows.filter((r) => r.kind === "remove").length,
        }
      : null,
  };
}

/** Per-owner weak cache; mutated/reused objects are checked against both strings.
 * No global payload-string cache and no persistence of computed comparisons. */
const comparisons = new WeakMap<
  object,
  { before: string | null; after: string; result: LineComparison }
>();
export function comparisonFor(value: {
  oldText: string | null;
  newText: string;
}): LineComparison {
  const prior = comparisons.get(value);
  if (prior && prior.before === value.oldText && prior.after === value.newText)
    return prior.result;
  const result = compareLines(value.oldText, value.newText);
  comparisons.set(value, {
    before: value.oldText,
    after: value.newText,
    result,
  });
  return result;
}
