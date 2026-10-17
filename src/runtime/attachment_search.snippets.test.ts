import { expect, it } from "vitest";
import { setup } from "./attachment_search.test-support";

const cases = [
  {
    name: "leading context starts inside a supplementary character",
    text: `😀${"x".repeat(55)}needle`,
    before: "x".repeat(55),
    after: "",
  },
  {
    name: "trailing context ends inside a supplementary character",
    text: `needle${"x".repeat(87)}😀`,
    before: "",
    after: "x".repeat(87),
  },
  {
    name: "complete supplementary characters fit both context windows",
    text: `😀${"x".repeat(54)}needle${"y".repeat(86)}😀`,
    before: `😀${"x".repeat(54)}`,
    after: `${"y".repeat(86)}😀`,
  },
  {
    name: "BMP characters keep the existing context bounds",
    text: `${"前".repeat(60)}needle${"后".repeat(92)}`,
    before: "前".repeat(56),
    after: "后".repeat(88),
  },
  {
    name: "literal original replacement characters are preserved",
    text: "原文� needle �原文",
    before: "原文� ",
    after: " �原文",
  },
];

it.each(cases)(
  "keeps current-file excerpts identical to a complete-scalar source slice: $name",
  async ({ text, before, after }) => {
    const h = setup([text]);
    const sourceBefore = JSON.stringify(h.s.items);
    expect(await h.search.start("needle", h.candidates, h.current)).toBe(true);
    const state = h.search.snapshot();
    expect(state.matches).toBe(1);
    expect(state.hits).toHaveLength(1);
    const hit = state.hits[0];
    expect(hit).toMatchObject({ before, match: "needle", after });
    // Encoding is not the implementation: this witnesses that rendering the
    // excerpt cannot introduce a replacement for an isolated surrogate.
    const excerpt = `${hit.before}${hit.match}${hit.after}`;
    expect(new TextDecoder().decode(new TextEncoder().encode(excerpt))).toBe(
      excerpt,
    );
    expect(text).toContain(excerpt);
    expect(hit.source).toBe(h.candidates[0]);
    expect(hit.file).toEqual(h.files.get(h.candidates[0].path!));
    expect(await h.search.verifyHit(hit, h.current)).toBe(true);
    expect(JSON.stringify(h.s.items)).toBe(sourceBefore);
    expect(state.bytes).toBe(Buffer.byteLength(text));
  },
);

it("preserves an exact supplementary-character query and its source version", async () => {
  const text = "before 😀 after";
  const h = setup([text]);
  await h.search.start("😀", h.candidates, h.current);
  expect(h.search.snapshot().hits[0]).toMatchObject({
    before: "before ",
    match: "😀",
    after: " after",
  });
  expect(h.search.snapshot().matches).toBe(1);
});
