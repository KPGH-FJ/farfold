import { describe, expect, it } from "vitest";
import {
  DOCX_SOURCE_LIMITS as L,
  DocxSourceBudget,
  DocxSourcePositions,
  isDocxSourcePosition,
} from "./docx_source_position";
import { DocxError } from "./docx_types";
import { parseXml, type DocxXml } from "./docx_xml";
const xml = (text: string) =>
  parseXml(new TextEncoder().encode(text), { nodes: 0, text: 0 });
const part = "word/document.xml";
describe("DOCX original element ancestry index", () => {
  it("does not count comments or text, and retains original intermediate elements", () => {
    const root = xml(
      "<document> before <!-- comment --><body><marker/><wrapper><p/></wrapper></body></document>",
    );
    const index = new DocxSourcePositions();
    const source = index.position(
      part,
      root,
      root.children[0].children[1].children[0],
    );
    expect(source).toEqual({ part, elementPath: [0, 1, 0] });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.elementPath)).toBe(true);
    expect(index.position(part, root, root.children[0].children[0])).toEqual({
      part,
      elementPath: [0, 0],
    });
  });
  it("rejects clones, another part's node, a replaced root, and a root target", () => {
    const root = xml("<document><p/></document>"),
      other = xml("<hdr><p/></hdr>"),
      index = new DocxSourcePositions();
    index.position(part, root, root.children[0]);
    expect(() =>
      index.position(part, root, structuredClone(root.children[0])),
    ).toThrow(DocxError);
    index.position("word/header1.xml", other, other.children[0]);
    expect(() => index.position(part, root, other.children[0])).toThrow(
      DocxError,
    );
    expect(() =>
      index.position(part, structuredClone(root), root.children[0]),
    ).toThrow(DocxError);
    expect(() => index.position(part, root, root)).toThrow(DocxError);
  });
  it("guards malformed cyclic/shared trees and excessive depth", () => {
    const root = xml("<document><p/></document>");
    root.children.push(root.children[0]);
    expect(() =>
      new DocxSourcePositions().position(part, root, root.children[0]),
    ).toThrow(DocxError);
    const cycle = xml("<document><p/></document>");
    cycle.children[0].children.push(cycle);
    expect(() =>
      new DocxSourcePositions().position(part, cycle, cycle.children[0]),
    ).toThrow(DocxError);
    const deep = xml("<document><p/></document>");
    let node: DocxXml = deep;
    for (let i = 0; i < 64; i++) {
      const next = { ...deep.children[0], children: [] };
      node.children = [next];
      node = next;
    }
    expect(() => new DocxSourcePositions().position(part, deep, node)).toThrow(
      DocxError,
    );
  });
});
describe("DOCX coordinate shape and aggregate budgets", () => {
  it("refuses sparse array holes including a structured-cloned Worker value", () => {
    const sparse = { part, elementPath: Array(1) };
    expect(isDocxSourcePosition(sparse)).toBe(false);
    expect(isDocxSourcePosition(structuredClone(sparse))).toBe(false);
  });
  it.each([
    "",
    "/a.xml",
    "a/",
    "a//b",
    "a/../b",
    "./a",
    "a\\b",
    "a%20b",
    "https:a",
    "a\u0000b",
    "a".repeat(1025),
  ])("rejects invalid part %j", (name) => {
    expect(isDocxSourcePosition({ part: name, elementPath: [0] })).toBe(false);
  });
  it.each([[], [-1], [0.1], [NaN], [Infinity], [500000], Array(64).fill(0)])(
    "rejects invalid element path %j",
    (path) => {
      expect(isDocxSourcePosition({ part, elementPath: path })).toBe(false);
    },
  );
  it("allows exact depth/index bounds without allowing extra fields", () => {
    expect(
      isDocxSourcePosition({ part, elementPath: Array(63).fill(499999) }),
    ).toBe(true);
    expect(
      isDocxSourcePosition({ part, elementPath: [0], quote: "text" }),
    ).toBe(false);
  });
  it("counts repeated Unicode part labels as UTF-8 bytes independently from content", () => {
    const budget = new DocxSourceBudget(),
      source = { part: "文".repeat(1000), elementPath: [0] };
    const times = Math.floor(L.partBytes / 3000);
    for (let i = 0; i < times; i++) budget.add(source);
    expect(() => budget.add(source)).toThrowError(
      expect.objectContaining({ code: "limit" }),
    );
  });
  it("enforces the total path-index allocation budget", () => {
    const budget = new DocxSourceBudget(),
      source = { part: "a", elementPath: Array(63).fill(0) };
    for (let i = 0; i < 10000; i++) budget.add(source);
    expect(() => budget.add(source)).toThrowError(
      expect.objectContaining({ code: "limit" }),
    );
  });
});
