import { useEffect, useRef, useState, type RefObject } from "react";
import { threads } from "../runtime/sessions";
import {
  loadedSearchHitIsCurrent,
  type LoadedSearchHit,
} from "../runtime/loaded_search";
import { loadedSearchDOMRange } from "../runtime/loaded_search_dom";
import {
  hasOpenSearchAncestors,
  revealSearchAncestors,
  searchDetailsCommitted,
} from "../runtime/transcript_search";
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
  const current = useRef(request);
  const resumePosition = useRef<(() => void) | undefined>(undefined);
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
    let root: HTMLElement | null | undefined;
    let observer: MutationObserver | undefined;
    let schedule: (() => void) | undefined;
    let settled = false;
    const stopWaiting = () => {
      observer?.disconnect();
      if (schedule) root?.removeEventListener("toggle", schedule, true);
      if (resumePosition.current === schedule)
        resumePosition.current = undefined;
    };
    const stale = () => {
      settled = true;
      stopWaiting();
      release();
      release = () => {};
      message?.classList.remove("search-match");
      registry?.delete("loaded-search");
      setStatus("stale");
    };
    let raf = requestAnimationFrame(() => {
      root = host.current?.querySelector<HTMLElement>(".transcript");
      const hit = request.hit;
      const valid = () =>
        !disposed &&
        current.current === request &&
        !!root?.isConnected &&
        host.current?.querySelector(".transcript") === root &&
        loadedSearchHitIsCurrent(hit, threads.getSnapshot().threads);
      if (!root || !valid()) {
        stale();
        return;
      }
      const found = loadedSearchDOMRange(root, hit);
      if (!found) {
        stale();
        return;
      }
      const parent = found.range.startContainer.parentElement;
      if (!parent) {
        stale();
        return;
      }
      release = revealSearchAncestors(parent, root);
      let pending = false;
      const position = () => {
        pending = false;
        const refreshed =
          root && valid() ? loadedSearchDOMRange(root, hit) : null;
        const currentParent = refreshed?.range.startContainer.parentElement;
        const endParent = refreshed?.range.endContainer.parentElement;
        if (!root || !refreshed || !currentParent || !endParent || !valid()) {
          stale();
          return;
        }
        // A requested expansion and cached rectangles do not prove that React
        // has committed the target or the previous disclosure's close. Retry
        // only on an owning DOM update/revision, not an animation-frame loop.
        if (
          !hasOpenSearchAncestors(currentParent, root) ||
          !hasOpenSearchAncestors(endParent, root) ||
          !searchDetailsCommitted(root) ||
          !currentParent.getClientRects().length ||
          !Array.from(refreshed.range.getClientRects()).some(
            (rect) => rect.width > 0 && rect.height > 0,
          )
        )
          return;
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
        message.focus({ preventScroll: true });
        if (valid() && currentParent.isConnected) {
          currentParent.scrollIntoView({
            block: "center",
            behavior: "instant",
          });
          scrollTranscriptRange(refreshed.range, root);
          settled = true;
          stopWaiting();
          setStatus("located");
        } else {
          stale();
        }
      };
      schedule = () => {
        if (disposed || settled || pending) return;
        pending = true;
        raf = requestAnimationFrame(position);
      };
      observer = new MutationObserver(schedule);
      observer.observe(root, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["open", "hidden"],
      });
      root.addEventListener("toggle", schedule, true);
      resumePosition.current = schedule;
      schedule();
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      stopWaiting();
      release();
      message?.classList.remove("search-match");
      registry?.delete("loaded-search");
    };
  }, [host, request, validNow]);
  useEffect(() => {
    resumePosition.current?.();
  }, [revision]);
  return (
    <div className="loaded-search-jump">
      <span role="status">{S[validNow ? status : "stale"]}</span>
      <button type="button" className="btn btn-text" onClick={onClose}>
        {S.close}
      </button>
    </div>
  );
}
