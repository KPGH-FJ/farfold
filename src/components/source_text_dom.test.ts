import { describe, expect, it } from "vitest";
import { sourceDomOffsets } from "./source_text_dom";

// A structural node fixture tests traversal only; browser tests use real Range/Text.
class N {
  constructor(
    readonly nodeType: number,
    readonly childNodes: N[] = [],
    readonly data = "",
  ) {}
  get textContent(): string {
    return this.nodeType === 3
      ? this.data
      : this.childNodes.map((n) => n.textContent).join("");
  }
}
const text = (value: string) => new N(3, [], value);
const element = (...nodes: N[]) => new N(1, nodes);
function offsets(
  root: N,
  start: N,
  a: number,
  end: N,
  b: number,
  value = root.textContent,
) {
  return sourceDomOffsets(
    root as unknown as HTMLElement,
    {
      startContainer: start,
      startOffset: a,
      endContainer: end,
      endOffset: b,
    } as unknown as Range,
    value,
  );
}
describe("exact source DOM offsets", () => {
  it("distinguishes the second repeated text using nodes, retaining CRLF/BOM", () => {
    const first = text("\uFEFF同名\r\n"),
      second = text("同名😀尾");
    const root = element(first, element(second));
    expect(offsets(root, second, 0, second, 2)).toEqual({ start: 5, end: 7 });
    expect(offsets(root, second, 2, second, 4)).toEqual({ start: 7, end: 9 });
  });
  it("supports element endpoints without including toolbar siblings", () => {
    const a = text("ab"),
      b = text("cd"),
      root = element(a, element(b));
    expect(offsets(root, root, 1, b, 1)).toEqual({ start: 2, end: 3 });
  });
  it("rejects foreign nodes and changed DOM text", () => {
    const node = text("aa"),
      root = element(node);
    expect(offsets(root, text("aa"), 0, node, 2)).toBeNull();
    expect(offsets(root, node, 0, node, 2, "ab")).toBeNull();
  });
  it("rejects invalid endpoint and empty/inverted range", () => {
    const node = text("abcd"),
      root = element(node);
    for (const [a, b] of [
      [-1, 2],
      [0, 5],
      [1, 1],
      [3, 1],
      [0.5, 2],
    ])
      expect(offsets(root, node, a, node, b)).toBeNull();
  });
});
