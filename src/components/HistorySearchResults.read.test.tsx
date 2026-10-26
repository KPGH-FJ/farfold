import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HistorySearchResults,
  HistorySearchText,
} from "./HistorySearchResults";
import type { HistoryReadOperation } from "../runtime/history_search_types";
import { parseHistoryReply } from "../runtime/history_search_types";
import {
  expected,
  operation as nativeOperation,
} from "../runtime/history_search.test-support";
import { HISTORY_SEARCH_STRINGS as S } from "../runtime/history_search_strings";

function result(): HistoryReadOperation {
  return {
    agentId: "fixture",
    requestId: "00000000-0000-4000-8000-000000000003",
    query: "hello",
    rowIds: ["saved-1"],
    source: "officialSessionLoad",
    scope: "userAndAssistantText",
    coverageScope: "acknowledgedLoadPrefix",
    textScope: "returnedVisibleFields",
    matchMode: "ecmascriptUnicodeLiteral",
    exclusions: ["attachments", "toolOutput", "reasoning", "otherMessageKinds"],
    state: "finished",
    settled: true,
    code: null,
    pendingCleanup: null,
    rows: [
      {
        rowId: "saved-1",
        coverage: "completeReturnedPrefix",
        textBlocksRead: 1,
        matchedTextBlocks: 1,
        skippedFields: 0,
        sourceStatus: "sourceUnconfirmed",
        code: null,
      },
    ],
    hits: [
      {
        rowId: "saved-1",
        role: "assistant",
        text: "🙂hello <script>",
        textTruncated: true,
        matches: [{ start: 2, end: 7 }],
        matchesTruncated: true,
        locator: { kind: "returnedText", blockIndex: 4, fieldIndex: 2 },
      },
    ],
  };
}
const html = (operation: HistoryReadOperation) =>
  renderToStaticMarkup(
    <HistorySearchResults
      operation={operation}
      title={() => "Selected conversation"}
      onPreview={vi.fn()}
    />,
  );
it("shows returned-visible-field coverage without inventing pages or a verified historical provider", () => {
  const op = result();
  const rendered = html(op);
  expect(rendered).toContain(S.readPrefixScope);
  expect(rendered).toContain(S.readSourceUnconfirmed);
  expect(rendered).toContain(S.readRowStates.completeReturnedPrefix);
  expect(rendered).not.toContain(S.readConfiguredSource);
  expect(rendered).not.toContain("1 页");
  const text = renderToStaticMarkup(<HistorySearchText hit={op.hits[0]} />);
  expect(text).toContain("🙂<mark>hello</mark> &lt;script&gt;");
  expect(text).not.toContain("<script>");
});
it("reports skipped or unread selected rows even when the local pass has ended", () => {
  const op = result();
  op.rowIds = ["saved-1", "saved-2"];
  op.rows = [
    { ...op.rows[0], coverage: "limited", skippedFields: 1 },
    {
      ...op.rows[0],
      rowId: "saved-2",
      coverage: "unread",
      textBlocksRead: 0,
      matchedTextBlocks: 0,
      sourceStatus: "notRead",
    },
  ];
  const rendered = html(op);
  expect(rendered).toContain(S.partial);
  expect(rendered).toContain(S.readRowStates.unread);
  expect(rendered).toContain(S.readRowStates.limited);
  expect(rendered).toContain("1 处未检索");
});
it("complete empty means no searchable text in this returned prefix", () => {
  const op = result();
  op.hits = [];
  op.rows = [
    {
      ...op.rows[0],
      coverage: "completeEmpty",
      textBlocksRead: 0,
      matchedTextBlocks: 0,
    },
  ];
  const rendered = html(op);
  expect(rendered).toContain(S.noText);
  expect(rendered).toContain(S.readRowStates.completeEmpty);
  expect(rendered).not.toContain(S.empty);
});
it("does not make the existing native wire parser accept the new local source", () => {
  const native = nativeOperation("completed");
  expect(parseHistoryReply(native, expected)).toEqual(native);
  expect(() =>
    parseHistoryReply(
      {
        kind: "operation",
        operation: {
          ...native.operation,
          source: "officialSessionLoad",
        },
      },
      expected,
    ),
  ).toThrow();
});
