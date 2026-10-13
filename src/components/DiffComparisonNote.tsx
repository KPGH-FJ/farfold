import { useState } from "react";
import type { LineComparison } from "../runtime/line_diff";
import {
  comparisonLabel,
  endingChangeLabel,
} from "../runtime/line_diff_presentation";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";

/** Labels describe the view and intentionally stay outside text-search blocks. */
export function DiffComparisonNote({
  result,
  fragment,
}: {
  result: LineComparison;
  fragment: boolean;
}) {
  const [limit, setLimit] = useState(20);
  return (
    <div className="diff-comparison-note" role="note">
      <span>{comparisonLabel(result, fragment)}</span>
      {result.precision !== "aligned" && (
        <details>
          <summary>{W.diffDetails}</summary>
          <p>
            {result.precision === "missing-before"
              ? W.missingOriginal
              : result.precision === "replacement"
                ? W.diffReplacement
                : W.diffUnavailable}
          </p>
        </details>
      )}
      {result.endingChanges.length > 0 && (
        <details>
          <summary>{W.diffEndings(result.endingChanges.length)}</summary>
          <ul>
            {result.endingChanges.slice(0, limit).map((change) => (
              <li key={`${change.oldLine}:${change.newLine}`}>
                {endingChangeLabel(change, fragment)}
              </li>
            ))}
          </ul>
          {result.endingChanges.length > limit && (
            <button type="button" onClick={() => setLimit(limit + 100)}>
              {W.showMore}
            </button>
          )}
        </details>
      )}
    </div>
  );
}
