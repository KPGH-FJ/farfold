import type {
  HistorySearchHit,
  HistorySearchOperation,
} from "../runtime/history_search_types";
import { HISTORY_SEARCH_STRINGS as S } from "../runtime/history_search_strings";

export function HistorySearchText({ hit }: { hit: HistorySearchHit }) {
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
  operation: HistorySearchOperation;
  title(rowId: string): string;
  onPreview(hit: HistorySearchHit): void;
}) {
  const matched = operation.rows.some((row) => row.matchedTextBlocks > 0);
  const partial = operation.rows.some((r) => r.state !== "complete");
  return (
    <>
      <details
        className="history-search-coverage"
        open={operation.settled && partial}
      >
        <summary>{S.details}</summary>
        <ul>
          {operation.rows.map((row) => (
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
          <li
            key={JSON.stringify([
              hit.rowId,
              hit.turnId,
              hit.itemId,
              hit.partIndex,
            ])}
          >
            <button
              className="history-search-hit"
              type="button"
              onClick={() => onPreview(hit)}
            >
              <span>
                <strong>{title(hit.rowId)}</strong> ·{" "}
                {hit.role === "user" ? S.user : S.agent}
              </span>
              <span className="history-search-excerpt">
                {hit.text.slice(
                  Math.max(0, hit.matches[0].start - 48),
                  hit.matches[0].end + 100,
                )}
              </span>
              <small>{S.chooseMatch}</small>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
