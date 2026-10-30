import {
  historySearchHitKey,
  type HistorySearchDisplayHit,
  type HistorySearchDisplayOperation,
} from "../runtime/history_search_types";
import { HISTORY_SEARCH_STRINGS as S } from "../runtime/history_search_strings";
import { searchSnippetContext } from "../runtime/search_snippet";

function listExcerpt(hit: HistorySearchDisplayHit) {
  const { start, end } = hit.matches[0];
  const { before, after } = searchSnippetContext(hit.text, start, end, 48, 100);
  return (
    (before.length < start ? "…" : "") +
    before +
    hit.text.slice(start, end) +
    after +
    (end + after.length < hit.text.length ? "…" : "")
  );
}

export function HistorySearchText({ hit }: { hit: HistorySearchDisplayHit }) {
  const parts = [];
  let from = 0;
  for (const [i, range] of hit.matches.entries()) {
    parts.push(hit.text.slice(from, range.start));
    parts.push(<mark key={i}>{hit.text.slice(range.start, range.end)}</mark>);
    from = range.end;
  }
  parts.push(hit.text.slice(from));
  return <pre className="history-search-text">{parts}</pre>;
}
export function HistorySearchResults({
  operation,
  title,
  onPreview,
}: {
  operation: HistorySearchDisplayOperation;
  title(rowId: string): string;
  onPreview(hit: HistorySearchDisplayHit): void;
}) {
  const matched = operation.rows.some((row) => row.matchedTextBlocks > 0);
  const partial =
    operation.source === "officialSessionLoad"
      ? operation.rows.some(
          (row) =>
            row.coverage !== "completeReturnedPrefix" &&
            row.coverage !== "completeEmpty",
        )
      : operation.rows.some((r) => r.state !== "complete");
  return (
    <>
      <details
        className="history-search-coverage"
        open={operation.settled && partial}
      >
        <summary>{S.details}</summary>
        {operation.source === "officialSdk" && <p>{S.registeredScope}</p>}
        {operation.source === "officialSessionLoad" && (
          <p>{S.readPrefixScope}</p>
        )}
        <ul>
          {operation.source === "officialSessionLoad"
            ? operation.rows.map((row) => (
                <li key={row.rowId}>
                  <strong>{title(row.rowId)}</strong>
                  <span>{S.readRowStates[row.coverage]}</span>
                  <small>
                    {S.readBlocks(
                      row.textBlocksRead,
                      row.matchedTextBlocks,
                      row.skippedFields,
                    )}
                    {row.code && ` · ${S.errors[row.code]}`}
                  </small>
                  {row.sourceStatus !== "notRead" && (
                    <small>
                      {row.sourceStatus === "configuredConnectionReported"
                        ? S.readConfiguredSource
                        : S.readSourceUnconfirmed}
                    </small>
                  )}
                </li>
              ))
            : operation.rows.map((row) => (
                <li key={row.rowId}>
                  <strong>{title(row.rowId)}</strong>
                  <span>{S.rowStates[row.state]}</span>
                  <small>
                    {S.blocks(
                      row.pagesRead,
                      row.textBlocksRead,
                      row.matchedTextBlocks,
                    )}
                    {row.code && ` · ${S.errors[row.code]}`}
                  </small>
                </li>
              ))}
        </ul>
      </details>
      {operation.settled && partial && <p>{S.partial}</p>}
      <h3>
        {S.results} · {S.matchCount(operation.hits.length)}
      </h3>
      {(operation.settled || matched) && !operation.hits.length && (
        <p>
          {matched
            ? S.unconfirmedMatches
            : operation.rows.some((row) => row.textBlocksRead > 0)
              ? S.empty
              : partial
                ? S.unreadText
                : S.noText}
        </p>
      )}
      <ul className="history-search-hits">
        {operation.hits.map((hit) => (
          <li key={historySearchHitKey(hit)}>
            <button
              className="history-search-hit"
              type="button"
              onClick={() => onPreview(hit)}
            >
              <span>
                <strong>{title(hit.rowId)}</strong> ·{" "}
                {hit.role === "user" ? S.user : S.agent}
              </span>
              <span className="history-search-excerpt">{listExcerpt(hit)}</span>
              <small>{S.chooseMatch}</small>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
