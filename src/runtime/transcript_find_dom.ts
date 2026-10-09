import { segmentedMatches } from "./transcript_find";

const boundaries = new Set([
  "P",
  "DIV",
  "PRE",
  "LI",
  "TD",
  "TH",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "TR",
  "BR",
]);
/** Explicit presentation blocks, including their folded text. No layout reads,
 * synthetic wrappers, message copies, attachment decoding or external reads. */
export function transcriptRanges(root: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];
  const ranges: Range[] = [];
  let texts: Text[] = [];
  const flush = () => {
    for (const match of segmentedMatches(
      texts.map((node) => node.data),
      query,
    )) {
      const range = document.createRange();
      range.setStart(texts[match.startIndex], match.startOffset);
      range.setEnd(texts[match.endIndex], match.endOffset);
      ranges.push(range);
    }
    texts = [];
  };
  // Walk once in document order. Nested fields interrupt the containing field,
  // so its suffix cannot move ahead of child matches or join across that child.
  const visit = (node: Node, inside: boolean) => {
    if (node.nodeType === 3) {
      if (inside && node.textContent) texts.push(node as Text);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    if (
      element.matches(
        "[data-copy-exclude], [data-find-exclude], .who, script, style, textarea, [aria-hidden='true']",
      ) ||
      (element.tagName === "BUTTON" &&
        !element.classList.contains("message-file-button"))
    ) {
      flush();
      return;
    }
    const field = element.hasAttribute("data-find-block");
    const excludeChildren = element.hasAttribute("data-find-exclude-children");
    const boundary =
      field || excludeChildren || boundaries.has(element.tagName);
    if (boundary) flush();
    const searchable = excludeChildren ? false : field || inside;
    for (const child of element.childNodes) visit(child, searchable);
    if (boundary) flush();
  };
  visit(root, false);
  flush();
  return ranges;
}
export function sameTextRange(a: Range | undefined, b: Range | undefined) {
  return (
    !!a &&
    !!b &&
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}
