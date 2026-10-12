import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { operation } from "../runtime/history_search.test-support";
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
