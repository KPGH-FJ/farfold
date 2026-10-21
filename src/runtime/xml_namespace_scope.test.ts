import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseXml as parseDocxXml, compatible, A, W, MC } from "./docx_xml";
import { parseXml as parsePptxXml } from "./pptx_xml";
import { parseDocx } from "./docx_parse";
import { docxFixture, replaceDocxPart } from "./docx_fixture";

const encode = (value: string) => new TextEncoder().encode(value);
const parsers = [
  ["docx", parseDocxXml],
  ["pptx", parsePptxXml],
] as const;

function namespaceDocument() {
  let xml = `<w:document xmlns:w="${W}"><w:body>`;
  for (let layer = 0; layer < 16; layer++) {
    const declarations = Array.from(
      { length: 63 },
      (_, index) => ` xmlns:q${layer}_${index}="urn:owned:${layer}:${index}"`,
    ).join("");
    xml += `<w:customXml${declarations}>`;
  }
  return (
    xml +
    "<w:p/>".repeat(256) +
    "</w:customXml>".repeat(16) +
    "</w:body></w:document>"
  );
}

it.each(parsers)(
  "retains declaration-scale namespace entries in %s",
  (_name, parse) => {
    const source = namespaceDocument();
    // Same owned source as the original two semantic resource failures.
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "4529e16ecf762215ac1d894a684ed5b15f5ccb0b9d961e68186620330415c854",
    );
    const budget = { nodes: 0, text: 0 };
    const tree = parse(encode(source), budget);
    const scopes = new Set<object>();
    const stack = [tree];
    let retainedBindings = 0;
    while (stack.length) {
      const node = stack.pop()!;
      if (!scopes.has(node.namespaces)) {
        scopes.add(node.namespaces);
        retainedBindings += Object.keys(node.namespaces).length;
      }
      expect(node.namespaces.w).toBe(W);
      stack.push(...node.children);
    }
    expect(budget).toEqual({ nodes: 274, text: 0 });
    expect(retainedBindings).toBeLessThanOrEqual(1009);
  },
);

it.each(parsers)(
  "preserves default, shadowed and sibling bindings in %s",
  (_name, parse) => {
    const tree = parse(
      encode(
        '<r xmlns="urn:outer" xmlns:k="urn:k"><a/><b xmlns="" xmlns:k="urn:inner"><c/></b><d/></r>',
      ),
      { nodes: 0, text: 0 },
    );
    const [a, b, d] = tree.children;
    expect(
      [tree, a, b, b.children[0], d].map((node) => node.namespaces.k),
    ).toEqual(["urn:k", "urn:k", "urn:inner", "urn:inner", "urn:k"]);
    expect([a, b, b.children[0], d].map((node) => node.namespaces[""])).toEqual(
      ["urn:outer", "", "", "urn:outer"],
    );
  },
);

it.each(parsers)(
  "keeps special prefix names as immutable data in %s",
  (_name, parse) => {
    const tree = parse(
      encode(
        '<r xmlns:__proto__="urn:outer" xmlns:constructor="urn:ctor"><a xmlns:__proto__="urn:inner"/><b/></r>',
      ),
      { nodes: 0, text: 0 },
    );
    const [a, b] = tree.children;
    expect([tree, a, b].map((node) => node.namespaces.__proto__)).toEqual([
      "urn:outer",
      "urn:inner",
      "urn:outer",
    ]);
    expect(a.namespaces.constructor).toBe("urn:ctor");
    expect(Object.isFrozen(tree.namespaces)).toBe(true);
    expect(Object.isFrozen(a.namespaces)).toBe(true);
    expect(() =>
      Object.defineProperty(a.namespaces, "constructor", { value: "changed" }),
    ).toThrow(TypeError);
    expect(b.namespaces.constructor).toBe("urn:ctor");
  },
);

function packageWith(xml: string) {
  return replaceDocxPart(
    docxFixture("01-text-values"),
    "word/document.xml",
    () => xml,
  );
}

it("preserves inherited and shadowed compatibility choices and MustUnderstand", () => {
  const choices = `<w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:k="${A}"><mc:AlternateContent><mc:Choice Requires="k"><w:p marker="inherited"/></mc:Choice><mc:Fallback><w:p marker="wrong"/></mc:Fallback></mc:AlternateContent><mc:AlternateContent><mc:Choice xmlns:k="urn:unknown" Requires="k"><w:p marker="wrong"/></mc:Choice><mc:Fallback><w:p marker="fallback"/></mc:Fallback></mc:AlternateContent><mc:AlternateContent><mc:Choice Requires="k"><w:p marker="sibling"/></mc:Choice><mc:Fallback><w:p marker="wrong"/></mc:Fallback></mc:AlternateContent></w:document>`;
  const tree = parseDocxXml(encode(choices), { nodes: 0, text: 0 });
  expect(tree.children.map((node) => compatible(node)[0].attrs.marker)).toEqual(
    ["inherited", "fallback", "sibling"],
  );
  const source = `<w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:k="${W}" mc:MustUnderstand="k"><w:body><w:p><w:r><w:t>KEPT</w:t></w:r></w:p></w:body></w:document>`;
  expect(parseDocx(packageWith(source)).blocks[0]).toMatchObject({
    kind: "paragraph",
    runs: [{ kind: "text", text: "KEPT" }],
  });
  for (const invalid of [
    source.replace(`xmlns:k="${W}"`, 'xmlns:k="urn:unknown"'),
    source.replace('mc:MustUnderstand="k"', 'mc:MustUnderstand="missing"'),
  ]) {
    expect(() => parseDocx(packageWith(invalid))).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
  }
});

it("keeps unsupported customXml partial rather than adopting its nested text", () => {
  const result = parseDocx(packageWith(namespaceDocument()));
  expect(result.partial).toBe(true);
  expect(result.blocks).toEqual([
    { kind: "notice", id: "block-1", code: "unsupportedContent" },
  ]);
  expect(result.warnings).toContainEqual({
    code: "unsupportedContent",
    count: 1,
  });
  expect(result.images).toEqual([]);
});
