/** DOM positions are local UTF-16 offsets; persisted coordinates belong to the runtime. */
export function sourceDomOffsets(
  root: HTMLElement,
  range: Range,
  text: string,
): { start: number; end: number } | null {
  if (root.textContent !== text) return null;
  const textLength = (node: Node): number =>
    node.nodeType === 3
      ? (node.textContent?.length ?? 0)
      : Array.from(node.childNodes).reduce(
          (sum, child) => sum + textLength(child),
          0,
        );
  const endpoint = (target: Node, offset: number): number | null => {
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    let total = 0;
    let answer: number | null = null;
    const visit = (node: Node) => {
      if (answer !== null) return;
      if (node === target) {
        if (node.nodeType === 3 && offset <= (node.textContent?.length ?? 0))
          answer = total + offset;
        else if (node.nodeType === 1 && offset <= node.childNodes.length) {
          answer = total;
          for (let i = 0; i < offset; i++)
            answer += textLength(node.childNodes[i]);
        }
        return;
      }
      if (node.nodeType === 3) total += node.textContent?.length ?? 0;
      else for (const child of Array.from(node.childNodes)) visit(child);
    };
    visit(root);
    return answer;
  };
  const start = endpoint(range.startContainer, range.startOffset);
  const end = endpoint(range.endContainer, range.endOffset);
  return start !== null && end !== null && start < end ? { start, end } : null;
}

export function sourceDomRange(
  root: HTMLElement,
  text: string,
  start: number,
  end: number,
): Range | null {
  if (
    root.textContent !== text ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= end ||
    end > text.length
  )
    return null;
  const point = (offset: number): [Node, number] | null => {
    let position = 0;
    let answer: [Node, number] | null = null;
    const visit = (node: Node) => {
      if (answer) return;
      if (node.nodeType === 3) {
        const length = node.textContent?.length ?? 0;
        if (offset <= position + length) answer = [node, offset - position];
        position += length;
      } else for (const child of Array.from(node.childNodes)) visit(child);
    };
    visit(root);
    return answer;
  };
  const a = point(start),
    b = point(end);
  if (!a || !b) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(...a);
  range.setEnd(...b);
  return range;
}
