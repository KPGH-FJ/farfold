import { expect, it } from "vitest";
import { segmentedMatches } from "./transcript_find";

it.each([256, 1024])(
  "maps every dense inline occurrence with linear segment reads: %i nodes",
  (count) => {
    const source = Array.from({ length: count }, () => "x");
    const original = [...source];
    let reads = 0;
    const observed = new Proxy(source, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    // Calls the actual production mapper. Counting input accesses avoids a
    // wall-clock threshold, copied legacy algorithm or truncated match set.
    expect(segmentedMatches(observed, "x")).toEqual(
      Array.from({ length: count }, (_, index) => ({
        startIndex: index,
        startOffset: 0,
        endIndex: index,
        endOffset: 1,
      })),
    );
    expect(reads).toBeLessThanOrEqual(8 * count);
    expect(source).toEqual(original);
  },
);

it("skips empty nodes while preserving both sides of exact node boundaries", () => {
  const segments = ["", "x", "", "x", ""];
  expect(segmentedMatches(segments, "x")).toEqual([
    { startIndex: 1, startOffset: 0, endIndex: 1, endOffset: 1 },
    { startIndex: 3, startOffset: 0, endIndex: 3, endOffset: 1 },
  ]);
  expect(segmentedMatches(segments, "xx")).toEqual([
    { startIndex: 1, startOffset: 0, endIndex: 3, endOffset: 1 },
  ]);
});

it("retains adjacent and distant results rather than reusing an earlier node", () => {
  expect(segmentedMatches(["x", "", "x gap ", "x", "", "x"], "x")).toEqual([
    { startIndex: 0, startOffset: 0, endIndex: 0, endOffset: 1 },
    { startIndex: 2, startOffset: 0, endIndex: 2, endOffset: 1 },
    { startIndex: 3, startOffset: 0, endIndex: 3, endOffset: 1 },
    { startIndex: 5, startOffset: 0, endIndex: 5, endOffset: 1 },
  ]);
});

it("maps a phrase across several inline nodes and interleaved empties", () => {
  expect(segmentedMatches(["ab", "", "c", "d", "", "ef"], " bcde ")).toEqual([
    { startIndex: 0, startOffset: 1, endIndex: 5, endOffset: 1 },
  ]);
});

it("preserves surrogate-pair offsets when emoji span text nodes", () => {
  expect(
    segmentedMatches(
      ["A\uD83D", "", "\uDE00 B ", "\uD83D", "\uDE00", " C"],
      "😀",
    ),
  ).toEqual([
    { startIndex: 0, startOffset: 1, endIndex: 2, endOffset: 1 },
    { startIndex: 3, startOffset: 0, endIndex: 4, endOffset: 1 },
  ]);
});

it("keeps original offsets through Unicode prefixes and case-insensitive matches", () => {
  expect(
    segmentedMatches(
      ["İstanbul ", "", "Fa", "rFOLD", "🙂 FAR", "fold"],
      " farfold ",
    ),
  ).toEqual([
    { startIndex: 2, startOffset: 0, endIndex: 3, endOffset: 5 },
    { startIndex: 4, startOffset: 3, endIndex: 5, endOffset: 4 },
  ]);
});

it("keeps literal metacharacters and empty or absent queries unchanged", () => {
  const segments = ["a", "+", "b a", ".", "b [", "x", "]"];
  expect(segmentedMatches(segments, "a+b")).toEqual([
    { startIndex: 0, startOffset: 0, endIndex: 2, endOffset: 1 },
  ]);
  expect(segmentedMatches(segments, "[x]")).toEqual([
    { startIndex: 4, startOffset: 2, endIndex: 6, endOffset: 1 },
  ]);
  expect(segmentedMatches(segments, "unmatched")).toEqual([]);
  expect(segmentedMatches(segments, "  ")).toEqual([]);
  expect(segmentedMatches([], "x")).toEqual([]);
  expect(segmentedMatches(["", "", ""], "x")).toEqual([]);
});

it.each([
  [
    "x",
    [
      [4, 5],
      [5, 6],
    ],
  ],
  [
    "😀",
    [
      [1, 3],
      [6, 8],
    ],
  ],
  ["İx", [[3, 5]]],
] as const)(
  "keeps every UTF-16 cut and empty-node placement exact for %s",
  (query, expected) => {
    const body = "A😀İxX😀";
    // Every possible partition of these eight UTF-16 code units, including
    // cuts inside both surrogate pairs. Add empty boundary/interior nodes.
    for (let mask = 0; mask < 1 << (body.length - 1); mask++) {
      const segments = [""];
      let from = 0;
      for (let offset = 1; offset <= body.length; offset++) {
        if (offset === body.length || mask & (1 << (offset - 1))) {
          segments.push(body.slice(from, offset), "");
          from = offset;
        }
      }
      const matches = segmentedMatches(segments, query);
      expect(matches).toHaveLength(expected.length);
      const starts = segments.map(
        (_, index) => segments.slice(0, index).join("").length,
      );
      expect(
        matches.map((match) => {
          const first = segments[match.startIndex];
          const last = segments[match.endIndex];
          expect(match.startOffset).toBeGreaterThanOrEqual(0);
          expect(match.startOffset).toBeLessThan(first.length);
          expect(match.endOffset).toBeGreaterThan(0);
          expect(match.endOffset).toBeLessThanOrEqual(last.length);
          return [
            starts[match.startIndex] + match.startOffset,
            starts[match.endIndex] + match.endOffset,
          ];
        }),
      ).toEqual(expected);
      expect(segments.join("")).toBe(body);
    }
  },
);
