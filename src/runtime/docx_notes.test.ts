import { expect, test } from "vitest";
import { parseDocx } from "./docx_parse";
import { checkedDocxDocument } from "./docx_validation";
import type { DocxDocument, DocxWorkerInput } from "./docx_types";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PR = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
type Kind = "footnote" | "endnote";
interface Note {
  id: string;
  text?: string;
  body?: string;
}
interface Reference {
  kind: Kind;
  id: string;
}

/** Owned logical OPC parts, not a native ZIP/capture or a source-application export. */
function input(
  refs: Reference[],
  footnotes: Note[],
  endnotes?: Note[],
): DocxWorkerInput {
  const groups: { kind: Kind; notes: Note[] }[] = [
    { kind: "footnote", notes: footnotes },
  ];
  if (endnotes) groups.push({ kind: "endnote", notes: endnotes });
  const document = `<w:document xmlns:w="${W}"><w:body><w:p>${refs
    .map((r) => `<w:r><w:${r.kind}Reference w:id="${r.id}"/></w:r>`)
    .join("")}</w:p></w:body></w:document>`;
  const types = `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${groups
    .map(
      ({ kind }) =>
        `<Override PartName="/word/${kind}s.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}s+xml"/>`,
    )
    .join("")}</Types>`;
  const parts: [string, string][] = [
    ["[Content_Types].xml", types],
    [
      "_rels/.rels",
      `<Relationships xmlns="${PR}"><Relationship Id="rDoc" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ],
    ["word/document.xml", document],
    [
      "word/_rels/document.xml.rels",
      `<Relationships xmlns="${PR}">${groups
        .map(
          ({ kind }) =>
            `<Relationship Id="r${kind}s" Type="${R}/${kind}s" Target="${kind}s.xml"/>`,
        )
        .join("")}</Relationships>`,
    ],
    ...groups.map(({ kind, notes }): [string, string] => [
      `word/${kind}s.xml`,
      `<w:${kind}s xmlns:w="${W}" xmlns:mc="${MC}" mc:MustUnderstand="w">${notes
        .map(
          (n) =>
            `<w:${kind} w:id="${n.id}">${n.body ?? `<w:p><w:r><w:t>${n.text ?? `NOTE_${n.id}`}</w:t></w:r></w:p>`}</w:${kind}>`,
        )
        .join("")}</w:${kind}s>`,
    ]),
  ];
  return {
    entries: parts.map(([name]) => name),
    parts: parts.map(([name, xml]) => ({
      name,
      data: Buffer.from(xml).toString("base64"),
    })),
  };
}
function parse(value: DocxWorkerInput): DocxDocument {
  return checkedDocxDocument(
    parseDocx(value),
    new Set(value.parts.map((p) => p.name)),
  );
}
function text(document: DocxDocument): string[] {
  return document.stories.map((story) =>
    story.blocks
      .flatMap((block) =>
        block.kind === "paragraph"
          ? block.runs.flatMap((run) => (run.kind === "text" ? [run.text] : []))
          : [],
      )
      .join(""),
  );
}
function sources(document: DocxDocument) {
  return document.stories.map(
    (story) => story.blocks[0].kind === "paragraph" && story.blocks[0].source,
  );
}

interface XmlShape {
  name: string;
  uri: string;
  attrs: Record<string, string>;
  namespaces: object;
  children: unknown[];
  text: string;
}
interface Counts {
  xmlPops: number;
  uniqueXmlNodesPopped: number;
  maxVisitsPerXmlNode: number;
  noteFilters: number;
  notePredicates: number;
}
const originals = {
  pop: Object.getOwnPropertyDescriptor(Array.prototype, "pop")!,
  filter: Object.getOwnPropertyDescriptor(Array.prototype, "filter")!,
};
function xml(value: unknown): value is XmlShape {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<XmlShape>;
  return (
    Object.hasOwn(v, "name") &&
    typeof v.name === "string" &&
    Object.hasOwn(v, "uri") &&
    typeof v.uri === "string" &&
    Object.hasOwn(v, "attrs") &&
    !!v.attrs &&
    typeof v.attrs === "object" &&
    Object.hasOwn(v, "namespaces") &&
    !!v.namespaces &&
    Object.hasOwn(v, "children") &&
    Array.isArray(v.children) &&
    Object.hasOwn(v, "text") &&
    typeof v.text === "string"
  );
}
// O(1) recognition only; never scan the receiver to identify an observation.
function noteArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || !value.length) return false;
  const first: unknown = value[0];
  return (
    xml(first) &&
    first.uri === W &&
    (first.name === "footnote" || first.name === "endnote")
  );
}
function restored(): boolean {
  return (["pop", "filter"] as const).every((name) => {
    const a = Object.getOwnPropertyDescriptor(Array.prototype, name)!;
    const b = originals[name];
    return (
      a.value === b.value &&
      a.get === b.get &&
      a.set === b.set &&
      a.writable === b.writable &&
      a.configurable === b.configurable &&
      a.enumerable === b.enumerable
    );
  });
}
type Predicate = (
  this: unknown,
  item: unknown,
  index: number,
  receiver: unknown[],
) => unknown;
function measured<T>(action: () => T): { value: T; counts: Counts } {
  const counts: Counts = {
    xmlPops: 0,
    uniqueXmlNodesPopped: 0,
    maxVisitsPerXmlNode: 0,
    noteFilters: 0,
    notePredicates: 0,
  };
  const visits = new WeakMap<object, number>();
  try {
    Object.defineProperty(Array.prototype, "pop", {
      ...originals.pop,
      value: function (this: unknown[]) {
        const value: unknown = Reflect.apply(
          originals.pop.value,
          this,
          arguments,
        );
        if (xml(value)) {
          const previous = visits.get(value);
          const next = (previous ?? 0) + 1;
          if (previous === undefined) counts.uniqueXmlNodesPopped++;
          visits.set(value, next);
          counts.xmlPops++;
          counts.maxVisitsPerXmlNode = Math.max(
            counts.maxVisitsPerXmlNode,
            next,
          );
        }
        return value;
      },
    });
    Object.defineProperty(Array.prototype, "filter", {
      ...originals.filter,
      value: function (
        this: unknown[],
        callback: Predicate,
        thisArg?: unknown,
      ) {
        if (typeof callback !== "function" || !noteArray(this))
          return Reflect.apply(originals.filter.value, this, arguments);
        counts.noteFilters++;
        return Reflect.apply(originals.filter.value, this, [
          function (
            this: unknown,
            item: unknown,
            index: number,
            receiver: unknown[],
          ) {
            counts.notePredicates++;
            return Reflect.apply(callback, this, [item, index, receiver]);
          },
          thisArg,
        ]);
      },
    });
    return { value: action(), counts };
  } finally {
    Object.defineProperty(Array.prototype, "pop", originals.pop);
    Object.defineProperty(Array.prototype, "filter", originals.filter);
  }
}

test("notes keep kind, literal IDs, reference order, deduplication and source paths", () => {
  const refs: Reference[] = [
    { kind: "footnote", id: "2" },
    { kind: "endnote", id: "2" },
    { kind: "footnote", id: "001" },
    { kind: "footnote", id: "-7" },
    { kind: "footnote", id: "2" },
    { kind: "endnote", id: "001" },
  ];
  const document = parse(
    input(
      refs,
      [{ id: "-7" }, { id: "2" }, { id: "001" }],
      [
        { id: "001", text: "END_001" },
        { id: "2", text: "END_2" },
      ],
    ),
  );
  expect(document.stories.map((s) => [s.kind, s.noteId])).toEqual([
    ["footnote", "2"],
    ["endnote", "2"],
    ["footnote", "001"],
    ["footnote", "-7"],
    ["endnote", "001"],
  ]);
  expect(text(document)).toEqual([
    "NOTE_2",
    "END_2",
    "NOTE_001",
    "NOTE_-7",
    "END_001",
  ]);
  expect(sources(document)).toEqual([
    { part: "word/footnotes.xml", elementPath: [1, 0] },
    { part: "word/endnotes.xml", elementPath: [1, 0] },
    { part: "word/footnotes.xml", elementPath: [2, 0] },
    { part: "word/footnotes.xml", elementPath: [0, 0] },
    { part: "word/endnotes.xml", elementPath: [0, 0] },
  ]);
  const p = document.blocks[0];
  if (p.kind !== "paragraph") throw Error("owned paragraph missing");
  expect(
    p.runs.map((r) => r.kind === "noteReference" && [r.noteKind, r.noteId]),
  ).toEqual(refs.map((r) => [r.kind, r.id]));
});

test("512 ordinary notes avoid repeated immutable-part walks and note-table predicates", () => {
  const refs = Array.from({ length: 512 }, (_, i): Reference => ({
    kind: "footnote",
    id: String(i + 1),
  }));
  const notes = Array.from({ length: 512 }, (_, i) => ({
    id: String(512 - i),
  }));
  const value = input(refs, notes);
  const { value: raw, counts } = measured(() => parseDocx(value));
  expect(restored()).toBe(true);
  const document = checkedDocxDocument(
    raw,
    new Set(value.parts.map((p) => p.name)),
  );
  expect(document.blocks).toHaveLength(1);
  expect(document.stories).toHaveLength(512);
  expect(text(document)).toEqual(
    Array.from({ length: 512 }, (_, i) => `NOTE_${i + 1}`),
  );
  expect(sources(document)[0]).toEqual({
    part: "word/footnotes.xml",
    elementPath: [511, 0],
  });
  expect(sources(document)[511]).toEqual({
    part: "word/footnotes.xml",
    elementPath: [0, 0],
  });
  // Original RED: 1,053,200 observed pops / 3,085 unique nodes, peak513,
  // 524,288 note predicates. Includes Saxes close-stack's linear baseline;
  // no timing/RSS or claim to count every future algorithm's work.
  expect(counts.maxVisitsPerXmlNode).toBeLessThanOrEqual(4);
  expect(counts.xmlPops).toBeLessThanOrEqual(8 * counts.uniqueXmlNodesPopped);
  expect(counts.notePredicates).toBeLessThanOrEqual(16 * 512);
});

test.each(["footnote", "endnote"] as const)(
  "%s missing/selected duplicate rejects; unused duplicate is unchanged",
  (kind) => {
    const make = (notes: Note[]) =>
      input(
        [{ kind, id: "2" }],
        kind === "footnote" ? notes : [],
        kind === "endnote" ? notes : undefined,
      );
    expect(() => measured(() => parseDocx(make([{ id: "1" }])))).toThrowError(
      "invalid",
    );
    expect(restored()).toBe(true);
    expect(() =>
      measured(() =>
        parseDocx(make([{ id: "2" }, { id: "2", text: "DUPLICATE" }])),
      ),
    ).toThrowError("invalid");
    expect(restored()).toBe(true);
    expect(
      text(parse(make([{ id: "2" }, { id: "99" }, { id: "99" }]))),
    ).toEqual(["NOTE_2"]);
  },
);

test.each(["footnote", "endnote"] as const)(
  "%s validates active/MustUnderstand content in the whole part",
  (kind) => {
    const refs: Reference[] = [{ kind, id: "2" }];
    for (const body of [
      '<w:p><w:ins w:id="7" w:author="owned"><w:r><w:t>UNUSED</w:t></w:r></w:ins></w:p>',
      `<w:p xmlns:x="urn:owned-unknown" xmlns:mc="${MC}" mc:MustUnderstand="x"/>`,
    ]) {
      const notes = [{ id: "2" }, { id: "99", body }];
      const value = input(
        refs,
        kind === "footnote" ? notes : [],
        kind === "endnote" ? notes : undefined,
      );
      expect(() => measured(() => parseDocx(value))).toThrowError(
        "unsupported",
      );
      expect(restored()).toBe(true);
    }
  },
);

test("note caches cannot reuse a prior parse's same part name/ID or validation result", () => {
  const refs: Reference[] = [{ kind: "footnote", id: "2" }];
  const first = input(refs, [{ id: "2", text: "FIRST" }]);
  const second = input(refs, [{ id: "2", text: "SECOND" }]);
  expect(text(parse(first))).toEqual(["FIRST"]);
  expect(text(parse(second))).toEqual(["SECOND"]);
  expect(() =>
    parse(
      input(refs, [
        { id: "2", text: "SECOND" },
        {
          id: "99",
          body: `<w:p xmlns:x="urn:owned-unknown" mc:MustUnderstand="x"/>`,
        },
      ]),
    ),
  ).toThrowError("unsupported");
  expect(text(parse(first))).toEqual(["FIRST"]);
});
