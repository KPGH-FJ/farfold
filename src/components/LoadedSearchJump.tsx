import { useEffect, useRef, useState, type RefObject } from "react";
import { threads } from "../runtime/sessions";
import {
  loadedSearchHitIsCurrent,
  type LoadedSearchHit,
} from "../runtime/loaded_search";
import { loadedSearchDOMRange } from "../runtime/loaded_search_dom";
import { revealSearchAncestors } from "../runtime/transcript_search";
import { scrollTranscriptRange } from "../runtime/transcript_find_scroll";
import { LOADED_SEARCH_STRINGS as S } from "../runtime/loaded_search_strings";
import "./LoadedSearchResults.css";

export type LoadedSearchRequest = { hit: LoadedSearchHit; token: object };
export function LoadedSearchJump({
  host,
  request,
  revision,
  onClose,
}: {
  host: RefObject<HTMLElement | null>;
  request: LoadedSearchRequest;
  revision: unknown;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<"locating" | "located" | "stale">(
    "locating",
  );
  const validNow = loadedSearchHitIsCurrent(
    request.hit,
    threads.getSnapshot().threads,
  );
  void revision;
  const current = useRef(request);
  current.current = request;
  useEffect(() => {
    if (!validNow) {
      setStatus("stale");
      return;
    }
    setStatus("locating");
    let disposed = false;
    let release = () => {};
    let message: HTMLElement | undefined;
    let registry: Map<string, unknown> | undefined;
    let raf = requestAnimationFrame(() => {
      const root = host.current?.querySelector<HTMLElement>(".transcript");
      const hit = request.hit;
      const valid = () =>
        !disposed &&
        current.current === request &&
        !!root?.isConnected &&
        loadedSearchHitIsCurrent(hit, threads.getSnapshot().threads);
      if (!root || !valid()) {
        setStatus("stale");
        return;
      }
      const found = loadedSearchDOMRange(root, hit);
      if (!found) {
        setStatus("stale");
        return;
      }
      const parent = found.range.startContainer.parentElement;
      if (!parent) {
        setStatus("stale");
        return;
      }
      release = revealSearchAncestors(parent, root);
      raf = requestAnimationFrame(() => {
        const refreshed = valid() ? loadedSearchDOMRange(root, hit) : null;
        const currentParent = refreshed?.range.startContainer.parentElement;
        if (!refreshed || !currentParent || !valid()) {
          release();
          release = () => {};
          setStatus("stale");
          return;
        }
        message = refreshed.message;
        message.classList.add("search-match");
        registry =
          typeof CSS !== "undefined"
            ? (CSS as typeof CSS & { highlights?: Map<string, unknown> })
                .highlights
            : undefined;
        const HighlightClass = (
          globalThis as typeof globalThis & {
            Highlight?: new () => { add: (range: Range) => unknown };
          }
        ).Highlight;
        if (registry && HighlightClass) {
          const highlight = new HighlightClass();
          highlight.add(refreshed.range);
          registry.set("loaded-search", highlight);
        }
        setStatus("located");
        message.focus({ preventScroll: true });
        if (valid() && currentParent.isConnected) {
          currentParent.scrollIntoView({
            block: "center",
            behavior: "instant",
          });
          scrollTranscriptRange(refreshed.range, root);
        }
      });
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      release();
      message?.classList.remove("search-match");
      registry?.delete("loaded-search");
    };
  }, [host, request, validNow]);
  return (
    <div className="loaded-search-jump">
      <span role="status">{S[validNow ? status : "stale"]}</span>
      <button type="button" className="btn btn-text" onClick={onClose}>
        {S.close}
      </button>
    </div>
  );
}
