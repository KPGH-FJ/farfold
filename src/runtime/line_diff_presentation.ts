import { WORKSPACE_STRINGS as W } from "./workspace_strings";
import type { EndingChange, LineComparison, LineEnding } from "./line_diff";

export function comparisonLabel(
  result: LineComparison,
  fragment: boolean,
): string {
  const scope = fragment ? W.diffFragment : W.diffContent;
  if (result.precision === "missing-before") return W.diffMissing;
  if (!result.stats) return `${scope} · ${W.diffPartial}`;
  return `${scope} · ${
    result.stats.adds || result.stats.removes
      ? W.diffCounts(result.stats.adds, result.stats.removes)
      : W.diffEqual
  }`;
}

function endingLabel(ending: LineEnding): string {
  return ending === "none"
    ? W.diffEndingNone
    : ending === "LF"
      ? W.diffEndingLF
      : W.diffEndingCRLF;
}
export function endingChangeLabel(
  change: EndingChange,
  fragment: boolean,
): string {
  const line = fragment ? W.fragmentLine : W.lineLabel;
  return `${W.fileBefore} ${line(change.oldLine)}：${endingLabel(change.before)}${W.diffEndingArrow}${W.fileAfter} ${line(change.newLine)}：${endingLabel(change.after)}`;
}

/** Human-readable comparison, not an applyable patch. Raw-side copying is separate. */
export function comparisonCopy(
  result: LineComparison,
  before: string | null,
  after: string,
  fragment: boolean,
): string {
  const body =
    result.precision === "unavailable" || result.precision === "replacement"
      ? `${result.precision === "unavailable" ? W.diffUnavailable : W.diffReplacement}\n${before === null ? W.missingOriginal : `${W.fileBefore}\n${before}`}\n${W.fileAfter}\n${after}`
      : result.rows
          .map(
            (row) =>
              `${row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}${row.text}`,
          )
          .join("\n");
  return [
    comparisonLabel(result, fragment),
    ...(result.precision === "missing-before" ? [W.missingOriginal] : []),
    body,
    ...(result.endingChanges.length
      ? [
          W.diffEndings(result.endingChanges.length),
          ...result.endingChanges.map((change) =>
            endingChangeLabel(change, fragment),
          ),
        ]
      : []),
  ].join("\n");
}
