/** Element positioning alone loses the selected offset inside a tall paragraph
 * or an independently scrolling tool/code block. Keep the first painted part
 * of the exact Range visible, working from inner scrollers to this transcript.
 * No wrappers, selection changes or text mutations are needed. */
export function scrollTranscriptRange(range: Range, root: HTMLElement): void {
  const parent = range.startContainer.parentElement;
  if (!parent || !root.contains(parent)) return;
  for (let node: HTMLElement | null = parent; node; node = node.parentElement) {
    const vertical =
      node.clientHeight > 0 && node.scrollHeight > node.clientHeight;
    const horizontal =
      node.clientWidth > 0 && node.scrollWidth > node.clientWidth;
    if (vertical || horizontal) {
      const style = getComputedStyle(node);
      const scrolls = (overflow: string) =>
        /^(auto|scroll|hidden|overlay)$/.test(overflow);
      const scrollY = vertical && scrolls(style.overflowY);
      const scrollX = horizontal && scrolls(style.overflowX);
      if (scrollY || scrollX) {
        // An inner scroll changes the Range's viewport geometry. Read it again
        // for every ancestor instead of applying one stale rectangle twice.
        const hit = Array.from(range.getClientRects()).find(
          (rect) => rect.width > 0 && rect.height > 0,
        );
        if (!hit) return;
        const box = node.getBoundingClientRect();
        const top = box.top + node.clientTop;
        const left = box.left + node.clientLeft;
        let nextTop = node.scrollTop;
        let nextLeft = node.scrollLeft;
        if (scrollY && (hit.top < top || hit.bottom > top + node.clientHeight))
          nextTop +=
            hit.top - top - Math.max(0, (node.clientHeight - hit.height) / 2);
        if (scrollX && (hit.left < left || hit.right > left + node.clientWidth))
          nextLeft +=
            hit.left - left - Math.max(0, (node.clientWidth - hit.width) / 2);
        if (nextTop !== node.scrollTop || nextLeft !== node.scrollLeft)
          node.scrollTo({
            top: nextTop,
            left: nextLeft,
            behavior: "instant",
          });
      }
    }
    if (node === root) break;
  }
}
