import { expect, it } from "vitest";
import { expected, operation, selection } from "./history_search.test-support";
import {
  parseHistoryReply,
  parseHistorySelection,
  validHistoryQuery,
} from "./history_search_types";
it("retains exact original text, UTF16 offsets and independent user content parts", () => {
  const wire = operation("completed", 3);
  const h = wire.operation.hits[0];
  h.text = "🙂HELLO";
  h.matches = [{ start: 2, end: 7 }];
  wire.operation.hits.push({
    ...h,
    partIndex: 1,
    text: "HELLO",
    matches: [{ start: 0, end: 5 }],
  });
  wire.operation.rows[0].textBlocksRead = 2;
  wire.operation.rows[0].matchedTextBlocks = 2;
  expect(parseHistoryReply(wire, expected)).toEqual(wire);
});
it.each([
  [
    "query bytes",
    (w: ReturnType<typeof operation>) => {
      w.operation.query = "other";
    },
  ],
  [
    "extra payload",
    (w: ReturnType<typeof operation>) => {
      Object.assign(w.operation, { raw: "PRIVATE" });
    },
  ],
  [
    "different scope",
    (w: ReturnType<typeof operation>) => {
      w.operation.rowIds = ["other"];
    },
  ],
  [
    "revision",
    (w: ReturnType<typeof operation>) => {
      w.operation.revision = -1;
    },
  ],
  [
    "terminal with queued row",
    (w: ReturnType<typeof operation>) => {
      w.operation.rows[0].state = "queued";
    },
  ],
  [
    "partial without reason",
    (w: ReturnType<typeof operation>) => {
      w.operation.rows[0].state = "partial";
    },
  ],
  [
    "surrogate boundary",
    (w: ReturnType<typeof operation>) => {
      w.operation.hits[0].text = "🙂hello";
      w.operation.hits[0].matches = [{ start: 1, end: 3 }];
    },
  ],
  [
    "overlapping ranges",
    (w: ReturnType<typeof operation>) => {
      w.operation.hits[0].matches = [
        { start: 0, end: 4 },
        { start: 3, end: 5 },
      ];
    },
  ],
  [
    "duplicate block",
    (w: ReturnType<typeof operation>) => {
      w.operation.hits.push({ ...w.operation.hits[0] });
    },
  ],
  [
    "assistant part",
    (w: ReturnType<typeof operation>) => {
      w.operation.hits[0].role = "assistant";
      w.operation.hits[0].partIndex = 1;
    },
  ],
  [
    "made up field",
    (w: ReturnType<typeof operation>) => {
      Object.assign(w.operation.hits[0], { uri: "https://private.test" });
    },
  ],
  [
    "wrong counter",
    (w: ReturnType<typeof operation>) => {
      w.operation.rows[0].matchedTextBlocks = 2;
    },
  ],
  [
    "complete with error",
    (w: ReturnType<typeof operation>) => {
      w.operation.code = "timedOut";
    },
  ],
] as const)("rejects contradictory or unrecognized %s", (_, change) => {
  const wire = operation("completed", 3);
  change(wire);
  expect(() => parseHistoryReply(wire, expected)).toThrow();
});
it("only an all-available ordered exact scope grants a selection ticket", () => {
  const good = selection();
  expect(parseHistorySelection(good, "fixture", expected.rowIds)).toEqual(good);
  expect(() =>
    parseHistorySelection(
      {
        ...good,
        rows: [
          { ...good.rows[0], availability: "unavailable", code: "alreadyOpen" },
        ],
      },
      "fixture",
      expected.rowIds,
    ),
  ).toThrow();
  expect(() => parseHistorySelection(good, "fixture", ["other"])).toThrow();
  expect(() =>
    parseHistorySelection(
      { ...good, selectionId: null },
      "fixture",
      expected.rowIds,
    ),
  ).toThrow();
});
it("query byte and scalar limits preserve legal exact whitespace without splitting user blocks", () => {
  expect(validHistoryQuery(" hello ")).toBe(true);
  expect(validHistoryQuery("🙂".repeat(64))).toBe(true);
  expect(validHistoryQuery("🙂".repeat(65))).toBe(false);
  expect(validHistoryQuery("\ud800")).toBe(false);
  expect(validHistoryQuery("hello\nworld")).toBe(false);
  expect(validHistoryQuery(" ")).toBe(false);
});
it("only explicit current-process closed absence carries admission closure", () => {
  const value = {
    kind: "absent",
    agentId: expected.agentId,
    requestId: expected.requestId,
    scope: "currentProcess",
    admissionClosed: false,
  };
  expect(parseHistoryReply(value, expected)).toEqual(value);
  expect(() =>
    parseHistoryReply({ ...value, scope: "allProcesses" }, expected),
  ).toThrow();
  expect(() =>
    parseHistoryReply({ ...value, requestId: "other" }, expected),
  ).toThrow();
});
it("selection expiry wording does not falsely attribute every expired ticket to an Agent setting change", async () => {
  const { HISTORY_SEARCH_STRINGS: S } =
    await import("./history_search_strings");
  expect(S.errors.selectionChanged).toContain("确认已失效");
  expect(S.errors.selectionChanged).not.toBe(
    "Agent 设置已变化，请重新检查读取方式。",
  );
});
