import { useEffect, useRef, useState, type RefObject } from "react";
import {
  transcriptRanges,
  sameTextRange,
} from "../runtime/transcript_find_dom";
import { revealSearchAncestors } from "../runtime/transcript_search";
import { LIBRARY } from "../runtime/library_strings";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";

const NO_RANGES: Range[] = [];

/** Ranges leave the React transcript untouched; unsupported highlight engines
 * still navigate exact ranges and outline the containing visible text block. */
export function ConversationFind({
  host,
  revision,
  onClose,
}: {
  host: RefObject<HTMLElement | null>;
  revision: unknown;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(0);
  const [matches, setMatches] = useState<{ query: string; ranges: Range[] }>({
    query: "",
    ranges: [],
  });
  const ranges = matches.query === query ? matches.ranges : NO_RANGES;
  const input = useRef<HTMLInputElement>(null);
  const selected = useRef<Range | undefined>(undefined);
  selected.current = ranges[position];
  const [navigation, setNavigation] = useState(0);
  const scheduleRefresh = useRef<(() => void) | undefined>(undefined);
  const schedulePosition = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    let root = host.current?.querySelector(".transcript");
    let pending = false;
    let frame = 0;
    const schedule = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        refresh();
      });
    };
    const observer = new MutationObserver(schedule);
    const refresh = () => {
      const currentRoot = host.current?.querySelector(".transcript");
      if (root !== currentRoot) {
        root?.removeEventListener("toggle", schedule, true);
        observer.disconnect();
        root = currentRoot;
        observe();
      }
      if (!root || !root.isConnected) return;
      const found = transcriptRanges(root as HTMLElement, query);
      const retained = found.findIndex((range) =>
        sameTextRange(range, selected.current),
      );
      setMatches({ query, ranges: found });
      setPosition((current) =>
        retained >= 0
          ? retained
          : Math.min(current, Math.max(0, found.length - 1)),
      );
      schedulePosition.current?.();
    };
    const observe = () => {
      if (!root) return;
      root.addEventListener("toggle", schedule, true);
      observer.observe(root, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["open", "hidden"],
      });
    };
    observe();
    scheduleRefresh.current = schedule;
    schedule();
    return () => {
      scheduleRefresh.current = undefined;
      cancelAnimationFrame(frame);
      root?.removeEventListener("toggle", schedule, true);
      observer.disconnect();
    };
  }, [query, host]);
  // Many streamed updates in the same frame share one scan. Revision updates
  // do not tear down pending work or re-create ranges before the next frame.
  useEffect(() => {
    scheduleRefresh.current?.();
  }, [revision]);
  useEffect(() => {
    const current = ranges[position];
    const parent = current?.startContainer.parentElement;
    parent?.classList.add("search-match");
    // CSS Custom Highlight API does not alter message text or copying.
    const registry =
      typeof CSS !== "undefined"
        ? (CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights
        : undefined;
    const HighlightClass = (
      globalThis as typeof globalThis & {
        Highlight?: new () => { add: (range: Range) => unknown };
      }
    ).Highlight;
    if (registry && HighlightClass) {
      // A one-character query can have hundreds of thousands of occurrences.
      // Incremental add avoids the JavaScript function-argument count limit.
      const all = new HighlightClass();
      for (const range of ranges) all.add(range);
      const active = new HighlightClass();
      if (current) active.add(current);
      registry.set("conversation-find", all);
      registry.set("conversation-find-current", active);
    }
    return () => {
      parent?.classList.remove("search-match");
      registry?.delete("conversation-find");
      registry?.delete("conversation-find-current");
    };
  }, [ranges, position]);
  const current = ranges[position];
  useEffect(() => {
    const root = host.current?.querySelector<HTMLElement>(".transcript");
    const parent = current?.startContainer.parentElement;
    if (!root || !parent || !root.contains(parent)) return;
    const release = revealSearchAncestors(parent, root);
    let pending = false;
    let positioned = false;
    let frame = 0;
    const schedule = () => {
      if (pending || positioned) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        if (
          root.isConnected &&
          parent.isConnected &&
          root.contains(parent) &&
          parent.getClientRects().length
        ) {
          parent.scrollIntoView({ block: "center" });
          positioned = true;
        }
      });
    };
    // A disclosure can commit after the first frame. Its DOM refresh resumes
    // only this unfinished navigation; later scans must not steal scrolling.
    schedulePosition.current = schedule;
    schedule();
    return () => {
      if (schedulePosition.current === schedule)
        schedulePosition.current = undefined;
      cancelAnimationFrame(frame);
      release();
    };
  }, [
    host,
    current?.startContainer,
    current?.startOffset,
    current?.endContainer,
    current?.endOffset,
    navigation,
  ]);
  const move = (direction: number) => {
    if (!ranges.length) return;
    setPosition((value) => (value + ranges.length + direction) % ranges.length);
    setNavigation((value) => value + 1);
  };
  return (
    <div
      className="thread-find"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          return;
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          move(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <span className="sr-only" id="conversation-find-scope">
        {R.findScopeDetails}
      </span>
      <input
        ref={input}
        autoFocus
        aria-label={LIBRARY.find}
        aria-describedby="conversation-find-scope"
        title={R.findScopeDetails}
        placeholder={R.findScope}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setPosition(0);
        }}
      />
      <span className="conversation-find-count" role="status">
        {query
          ? ranges.length
            ? R.findPosition(position + 1, ranges.length)
            : LIBRARY.findEmpty
          : ""}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label={R.findPrevious}
        disabled={!ranges.length}
        onClick={() => move(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={R.findNext}
        disabled={!ranges.length}
        onClick={() => move(1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={LIBRARY.cancel}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
