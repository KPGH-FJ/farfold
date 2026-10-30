import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { operation } from "../runtime/history_search.test-support";
import type { HistorySearchDisplayOperation } from "../runtime/history_search_types";
import {
  HistorySearchResults,
  HistorySearchText,
} from "./HistorySearchResults";
it("returned text is literal, has no URL fetch/link/HTML execution and preserves Unicode highlighting", () => {
  const hit = operation("completed", 2).operation.hits[0];
  hit.text = '🙂hello <img src="https://private.test/x">';
  hit.matches = [{ start: 2, end: 7 }];
  const html = renderToStaticMarkup(<HistorySearchText hit={hit} />);
  expect(html).toContain("🙂<mark>hello</mark>");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
});
it("empty partial results report actual coverage and no whole-history claim", () => {
  const op = operation("completed", 2).operation;
  op.hits = [];
  op.rows[0].matchedTextBlocks = 0;
  op.rows[0].state = "partial";
  op.rows[0].code = "resultLimit";
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={op}
      title={() => "Selected"}
      onPreview={vi.fn()}
    />,
  );
  expect(html).toContain("本次未能检索全部所选内容");
  expect(html).toContain("在已检索文字中没有匹配内容");
  expect(html).toContain("只读取了部分内容");
  expect(html).not.toContain("全部历史已");
});
it("zero read coverage with only failures does not claim searched text had no match", () => {
  const op = operation("failed", 2).operation;
  op.rows[0].pagesRead = 0;
  op.rows[0].textBlocksRead = 0;
  op.rows[0].matchedTextBlocks = 0;
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={op}
      title={() => "Unreturned"}
      onPreview={vi.fn()}
    />,
  );
  expect(html).not.toContain("在已检索文字中没有匹配内容");
  expect(html).toContain("本次未读取到可检索文字");
});
it("confirmed empty returned coverage is distinct from failed unread coverage", () => {
  const op = operation("completed", 2).operation;
  op.hits = [];
  op.rows[0].textBlocksRead = 0;
  op.rows[0].matchedTextBlocks = 0;
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={op}
      title={() => "Empty"}
      onPreview={vi.fn()}
    />,
  );
  expect(html).toContain("本次返回范围中没有可检索文字");
  expect(html).not.toContain("在已检索文字中没有匹配内容");
});

type ExcerptSource = "officialAppServer" | "officialSessionLoad";
function excerptOperation(source: ExcerptSource, text: string) {
  const native = operation("completed", 2).operation;
  const start = text.indexOf("needle");
  const fields = {
    text,
    textTruncated: false,
    matches: [{ start, end: start + 6 }],
    matchesTruncated: false,
  };
  const result: HistorySearchDisplayOperation =
    source === "officialAppServer"
      ? {
          ...native,
          query: "needle",
          hits: [{ ...native.hits[0], ...fields }],
        }
      : {
          agentId: native.agentId,
          requestId: native.requestId,
          query: "needle",
          rowIds: native.rowIds,
          source: "officialSessionLoad",
          scope: "userAndAssistantText",
          coverageScope: "acknowledgedLoadPrefix",
          textScope: "returnedVisibleFields",
          matchMode: "ecmascriptUnicodeLiteral",
          exclusions: native.exclusions,
          state: "finished",
          settled: true,
          code: null,
          pendingCleanup: null,
          rows: [
            {
              rowId: native.rowIds[0],
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
              rowId: native.rowIds[0],
              role: "user",
              ...fields,
              locator: { kind: "returnedText", blockIndex: 0, fieldIndex: 0 },
            },
          ],
        };
  return result;
}
function actualExcerpt(result: HistorySearchDisplayOperation) {
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={result}
      title={() => "Selected"}
      onPreview={vi.fn()}
    />,
  );
  const match = /<span class="history-search-excerpt">([\s\S]*?)<\/span>/.exec(
    html,
  );
  expect(match).not.toBeNull();
  return match![1];
}
function checkExcerpt(
  source: ExcerptSource,
  text: string,
  expected: string,
  wellFormed = true,
) {
  const result = excerptOperation(source, text);
  const before = JSON.stringify(result);
  const excerpt = actualExcerpt(result);
  if (wellFormed)
    expect(new TextDecoder().decode(new TextEncoder().encode(excerpt))).toBe(
      excerpt,
    );
  expect(excerpt).toBe(expected);
  const detail = renderToStaticMarkup(
    <HistorySearchText hit={result.hits[0]} />,
  );
  expect(detail.replace(/<[^>]*>/g, "")).toBe(text);
  expect(JSON.stringify(result)).toBe(before);
}

it.each(["officialAppServer", "officialSessionLoad"] as const)(
  "%s list excerpt does not split the supplementary character at its start",
  (source) => {
    // The selected-read producer can return this exact 56-unit prefix.
    checkExcerpt(
      source,
      "a".repeat(7) + "🙂" + "b".repeat(47) + "needle",
      "…" + "b".repeat(47) + "needle",
    );
  },
);
it.each(["officialAppServer", "officialSessionLoad"] as const)(
  "%s keeps a complete supplementary prefix at the 48-unit boundary",
  (source) => {
    const text = "🙂" + "b".repeat(46) + "needle";
    checkExcerpt(source, text, text);
  },
);
it.each(["officialAppServer", "officialSessionLoad"] as const)(
  "%s keeps a short ASCII excerpt without invented omission markers",
  (source) =>
    checkExcerpt(source, "before needle after", "before needle after"),
);
it.each(["officialAppServer", "officialSessionLoad"] as const)(
  "%s preserves an isolated source code unit instead of repairing original text",
  (source) =>
    checkExcerpt(source, "\ud83dneedle\ude42", "\ud83dneedle\ude42", false),
);
it("does not split a supplementary character at the official AppServer excerpt end", () => {
  checkExcerpt(
    "officialAppServer",
    "needle" + "b".repeat(99) + "🙂tail",
    "needle" + "b".repeat(99) + "…",
  );
});
it("keeps a complete supplementary suffix at the official AppServer 100-unit boundary", () => {
  const text = "needle" + "b".repeat(98) + "🙂";
  checkExcerpt("officialAppServer", text, text);
});
it("retains the 48/100 ASCII budgets and marks both actual list omissions", () => {
  checkExcerpt(
    "officialAppServer",
    "a".repeat(60) + "needle" + "b".repeat(120),
    "…" + "a".repeat(48) + "needle" + "b".repeat(100) + "…",
  );
});
it("keeps the selected-read producer's complete 88-unit suffix", () => {
  const text = "needle" + "b".repeat(86) + "🙂";
  checkExcerpt("officialSessionLoad", text, text);
});
