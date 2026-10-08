import { useEffect, useRef, useState } from "react";

// Search only the rendered conversation, not hidden or unavailable history.
export default function useConversationFind(container, query, revision) {
  const ranges = useRef([]);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const focusMatch = (next) => {
    const range = ranges.current[next];
    if (!range) return;
    setIndex(next);
    range.startContainer.parentElement?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
    if (globalThis.CSS?.highlights && globalThis.Highlight)
      CSS.highlights.set("conversation-current-match", new Highlight(range));
  };
  useEffect(() => {
    ranges.current = [];
    setCount(0);
    setIndex(0);
    const clear = () => {
      globalThis.CSS?.highlights?.delete("conversation-search");
      globalThis.CSS?.highlights?.delete("conversation-current-match");
    };
    clear();
    if (!query?.trim() || !container.current) return clear;
    const search = query.trim().toLocaleLowerCase();
    const walker = document.createTreeWalker(
      container.current,
      NodeFilter.SHOW_TEXT,
    );
    let node;
    while ((node = walker.nextNode())) {
      if (
        !node.parentElement?.closest(
          "p,code,.conv-step-title,h2,.conv-result-files button",
        )
      )
        continue;
      const text = node.textContent.toLocaleLowerCase();
      let start = text.indexOf(search);
      while (start >= 0) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + search.length);
        if (range.getClientRects().length) ranges.current.push(range);
        start = text.indexOf(search, start + Math.max(1, search.length));
      }
    }
    setCount(ranges.current.length);
    if (globalThis.CSS?.highlights && globalThis.Highlight)
      CSS.highlights.set(
        "conversation-search",
        new Highlight(...ranges.current),
      );
    focusMatch(0);
    return clear;
  }, [query, revision]);
  return {
    count,
    index,
    move: (offset) => {
      if (ranges.current.length)
        focusMatch(
          (index + offset + ranges.current.length) % ranges.current.length,
        );
    },
  };
}
