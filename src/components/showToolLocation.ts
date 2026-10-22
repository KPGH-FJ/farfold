import { flushSync } from "react-dom";
import { openTranscriptAncestors } from "../runtime/transcript_search";

/** Compare dataset values instead of treating an Agent-supplied ID as CSS. */
export function showToolLocation(root: HTMLElement | null, itemId: string) {
  if (!root) return;
  const matches = [
    ...root.querySelectorAll<HTMLElement>("[data-tool-item]"),
  ].filter((node) => node.dataset.toolItem === itemId);
  if (matches.length !== 1) return;
  const target = matches[0];
  flushSync(() => openTranscriptAncestors(target, root));
  if (!root.contains(target)) return;
  target.scrollIntoView({ block: "center", behavior: "auto" });
  target.focus({ preventScroll: true });
}
