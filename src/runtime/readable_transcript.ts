const controls = new Set([
  "BUTTON",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "SVG",
  "SCRIPT",
  "STYLE",
  "AUDIO",
  "VIDEO",
]);
const blocks = new Set([
  "DIV",
  "SECTION",
  "ARTICLE",
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "LI",
  "PRE",
  "SUMMARY",
  "SMALL",
  "FIGURE",
  "FIGCAPTION",
  "TR",
]);

/** Copy the currently rendered conversation only, never stored or unloaded
 * history. Offscreen scroll content remains readable; collapsed detail does not. */
export function readableTranscript(
  root: Element | null,
  title: string,
): string {
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return "";
    const element = node as HTMLElement;
    if (
      element.hidden ||
      element.getAttribute("aria-hidden") === "true" ||
      element.hasAttribute("data-copy-exclude") ||
      controls.has(element.tagName)
    )
      return "";
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    )
      return "";
    if (element.tagName === "BR") return "\n";
    const children =
      element.tagName === "DETAILS" && !element.hasAttribute("open")
        ? Array.from(element.children).filter(
            (child) => child.tagName === "SUMMARY",
          )
        : Array.from(element.childNodes);
    const content = children.map(read).join("");
    if (element.tagName === "TD" || element.tagName === "TH")
      return `${content}\t`;
    return blocks.has(element.tagName) ? `\n${content}\n` : content;
  };
  return [
    title,
    root
      ? read(root)
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/^\n+|\n+$/g, "")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
