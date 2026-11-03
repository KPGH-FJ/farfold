/** A collapsed details body may still report cached rectangles. */
export function hasOpenDisclosureAncestors(
  element: HTMLElement,
  root: HTMLElement,
) {
  if (!root.contains(element)) return false;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    if (node.hidden) return false;
    if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) {
      const summary = Array.from(node.children).find(
        (child) => child.tagName === "SUMMARY",
      );
      if (!summary?.contains(element)) return false;
    }
    if (node === root) return true;
  }
  return false;
}
