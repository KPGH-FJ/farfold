import { afterEach, expect, it, vi } from "vitest";
import { transcriptRanges } from "./transcript_find_dom";

type TextNode = { nodeType: 3; data: string; textContent: string };
type ElementNode = {
  nodeType: 1;
  tagName: string;
  childNodes: TestNode[];
  hasAttribute: (name: string) => boolean;
  classList: { contains: (name: string) => boolean };
  matches: (selector: string) => boolean;
  querySelectorAll: () => ElementNode[];
};
type TestNode = TextNode | ElementNode;
function text(data: string): TextNode {
  return { nodeType: 3, data, textContent: data };
}
function element(
  tagName: string,
  attributes: string[],
  children: TestNode[],
): ElementNode {
  const node: ElementNode = {
    nodeType: 1,
    tagName,
    childNodes: children,
    hasAttribute: (name: string) => attributes.includes(name),
    classList: { contains: (name: string) => attributes.includes(`.${name}`) },
    matches: (selector: string) =>
      attributes.some(
        (name) =>
          selector.includes(`[${name}]`) ||
          selector.split(/,\s*/).includes(name),
      ),
    querySelectorAll: (): ReturnType<typeof element>[] =>
      children.flatMap((child) =>
        child.nodeType === 1
          ? [
              ...(child.hasAttribute("data-find-block") ? [child] : []),
              ...child.querySelectorAll(),
            ]
          : [],
      ),
  };
  return node;
}
function matches(root: ReturnType<typeof element>, query: string) {
  vi.stubGlobal("document", {
    createRange: () => ({
      startContainer: undefined as unknown,
      endContainer: undefined as unknown,
      startOffset: 0,
      endOffset: 0,
      setStart(node: unknown, offset: number) {
        this.startContainer = node;
        this.startOffset = offset;
      },
      setEnd(node: unknown, offset: number) {
        this.endContainer = node;
        this.endOffset = offset;
      },
    }),
  });
  return transcriptRanges(root as unknown as HTMLElement, query);
}
afterEach(() => vi.unstubAllGlobals());

it("returns nested registered fields in document order without joining parent text across a child", () => {
  const before = text("hit before"),
    inside = text("hit inside"),
    after = text("hit after");
  const root = element(
    "DIV",
    [],
    [
      element(
        "DIV",
        ["data-find-block"],
        [before, element("SPAN", ["data-find-block"], [inside]), after],
      ),
    ],
  );
  expect(matches(root, "hit").map((range) => range.startContainer)).toEqual([
    before,
    inside,
    after,
  ]);
  expect(matches(root, "beforehit")).toHaveLength(0);
});
it("finds nested explicit attachment fields while omitting generated attachment labels and controls", () => {
  const root = element(
    "DIV",
    [],
    [
      element(
        "DIV",
        ["data-find-block"],
        [
          text("body"),
          element(
            "DIV",
            ["data-find-exclude-children"],
            [
              text("generated"),
              element("SPAN", ["data-find-block"], [text("name")]),
              element("BUTTON", [], [text("name")]),
            ],
          ),
        ],
      ),
    ],
  );
  expect(matches(root, "generated")).toHaveLength(0);
  expect(matches(root, "name")).toHaveLength(1);
});
it("keeps inline text contiguous and paragraph, controls, and source fields separate", () => {
  const root = element(
    "DIV",
    [],
    [
      element(
        "DIV",
        ["data-find-block"],
        [
          element(
            "P",
            [],
            [text("Farf"), element("STRONG", [], [text("old")])],
          ),
          element("P", [], [text("next")]),
          element("BUTTON", ["data-copy-exclude"], [text("Farfold")]),
          element("BUTTON", [".message-file-button"], [text("report.md")]),
        ],
      ),
    ],
  );
  expect(matches(root, "Farfold")).toHaveLength(1);
  expect(matches(root, "oldnext")).toHaveLength(0);
  expect(matches(root, "report.md")).toHaveLength(1);
});
