import type {
  LoadedSearchHit,
  LoadedSearchResult,
} from "../runtime/loaded_search";
import { LOADED_SEARCH_STRINGS as S } from "../runtime/loaded_search_strings";
import "./LoadedSearchResults.css";

export function LoadedSearchSummary({
  result,
  busy,
  failed,
  query,
}: {
  result: LoadedSearchResult | null;
  busy: boolean;
  failed: boolean;
  query: string;
}) {
  return (
    <div className="loaded-search-summary" role="status">
      <p>{S.boundary}</p>
      {busy ? (
        <p>{S.searching}</p>
      ) : failed ? (
        <p>{S.failed}</p>
      ) : (
        result && (
          <>
            <p>
              {S.coverage(result.loaded)} · {S.unloaded(result.unloaded)} ·{" "}
              {S.unavailable(result.unavailable)}
            </p>
            <p>
              {!query.trim()
                ? S.enter
                : result.matches
                  ? S.matches(result.matches)
                  : S.empty}
            </p>
            {result.matches > result.hits.length && <p>{S.limited}</p>}
            {result.skippedFields > 0 && (
              <p>
                {S.skipped(result.skippedFields)} · {S.budget}
              </p>
            )}
          </>
        )
      )}
    </div>
  );
}
export function LoadedSearchResults({
  hits,
  title,
  onChoose,
  selected,
  onSelect,
  id,
}: {
  hits: readonly LoadedSearchHit[];
  title: (key: string) => string;
  onChoose: (hit: LoadedSearchHit) => void;
  selected?: number;
  onSelect?: (index: number) => void;
  id?: string;
}) {
  return (
    <>
      {hits.map((hit, index) => (
        <button
          key={`${hit.threadKey}:${hit.itemId}:${index}`}
          id={id ? `${id}-${index}` : undefined}
          type="button"
          className="loaded-search-hit"
          role={id ? "option" : undefined}
          aria-selected={id ? selected === index : undefined}
          tabIndex={id ? -1 : undefined}
          onMouseEnter={() => onSelect?.(index)}
          onClick={() => onChoose(hit)}
        >
          <strong>{title(hit.threadKey)}</strong>
          <small>
            {hit.role === "user" ? S.user : S.agent}
            {hit.attachmentIndex !== null ? ` · ${S.attachment}` : ""}
          </small>
          <span>
            {hit.before}
            <mark>{hit.match}</mark>
            {hit.after}
          </span>
        </button>
      ))}
    </>
  );
}
