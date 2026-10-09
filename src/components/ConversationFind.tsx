import { useEffect, useRef, useState, type RefObject } from "react";
import { segmentedMatches } from "../runtime/transcript_find";
import { LIBRARY } from "../runtime/library_strings";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";

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
  const [ranges, setRanges] = useState<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const root = host.current?.querySelector(".transcript");
    const refresh = () => {
      const found: Range[] = [];
      if (root && query.trim()) {
        for (const block of root.querySelectorAll(
          ".msg-user, .assistant, .thinking-block, .steps",
        )) {
          const texts: Node[] = [];
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const parent = node.parentElement;
            if (
              !parent ||
              parent.closest("button, [data-copy-exclude], .who") ||
              !parent.getClientRects().length
            )
              continue;
            texts.push(node);
          }
          for (const match of segmentedMatches(
            texts.map((node) => node.textContent ?? ""),
            query,
          )) {
            const range = document.createRange();
            range.setStart(texts[match.startIndex], match.startOffset);
            range.setEnd(texts[match.endIndex], match.endOffset);
            found.push(range);
          }
        }
      }
      setRanges(found);
      setPosition((current) =>
        Math.min(current, Math.max(0, found.length - 1)),
      );
    };
    refresh();
    if (!root) return;
    // Native details and local attachment expansion do not update the thread
    // revision. Watch the visible transcript without observing our highlight class.
    root.addEventListener("toggle", refresh, true);
    const observer = new MutationObserver(refresh);
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "hidden"],
    });
    return () => {
      root.removeEventListener("toggle", refresh, true);
      observer.disconnect();
    };
  }, [query, revision, host]);
  useEffect(() => {
    const current = ranges[position];
    const parent = current?.startContainer.parentElement;
    parent?.classList.add("search-match");
    parent?.scrollIntoView({ block: "center" });
    // CSS Custom Highlight API does not alter message text or copying.
    const registry =
      typeof CSS !== "undefined"
        ? (CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights
        : undefined;
    const HighlightClass = (
      globalThis as typeof globalThis & {
        Highlight?: new (...ranges: Range[]) => unknown;
      }
    ).Highlight;
    if (registry && HighlightClass) {
      registry.set("conversation-find", new HighlightClass(...ranges));
      registry.set(
        "conversation-find-current",
        new HighlightClass(...(current ? [current] : [])),
      );
    }
    return () => {
      parent?.classList.remove("search-match");
      registry?.delete("conversation-find");
      registry?.delete("conversation-find-current");
    };
  }, [ranges, position]);
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
          if (ranges.length)
            setPosition(
              (position + (event.shiftKey ? ranges.length - 1 : 1)) %
                ranges.length,
            );
        }
      }}
    >
      <input
        ref={input}
        autoFocus
        aria-label={LIBRARY.find}
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
        onClick={() =>
          setPosition((position + ranges.length - 1) % ranges.length)
        }
      >
        ↑
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={R.findNext}
        disabled={!ranges.length}
        onClick={() => setPosition((position + 1) % ranges.length)}
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
