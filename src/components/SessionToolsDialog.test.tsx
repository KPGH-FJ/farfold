import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SessionToolsReportView,
  SessionToolStartupView,
} from "./SessionToolsDialog";
import type { SessionToolsReport } from "../runtime/session_tools_types";

const report: SessionToolsReport = {
  observedAtMs: 1000,
  completeness: "unreported",
  reportedItemCount: 0,
  itemsTruncated: false,
  items: [],
};
it("keeps a successful zero-item report incomplete and makes no absence or connection claim", () => {
  const html = renderToStaticMarkup(<SessionToolsReportView report={report} />);
  expect(html).toContain("程序本次返回 0 项工具信息");
  expect(html).toContain("报告完整性未提供");
  expect(html).not.toContain("没有工具");
  expect(html).not.toContain("已连接");
  expect(html).not.toContain("调用成功");
});
it("renders descriptions literally and separates reported permission from execution", () => {
  const html = renderToStaticMarkup(
    <SessionToolsReportView
      report={{
        ...report,
        reportedItemCount: 2,
        items: [
          {
            name: "<script>bad</script>",
            description:
              '[link](https://example.invalid) <img src="x" onerror="bad()">',
            permission: "ask_before",
            nameTruncated: false,
            descriptionTruncated: true,
          },
          {
            name: "<script>bad</script>",
            description: null,
            permission: null,
            nameTruncated: true,
            descriptionTruncated: false,
          },
        ],
      }}
    />,
  );
  expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
  expect(html.match(/<li>/g)).toHaveLength(2);
  expect(html).toContain("需要先确认");
  expect(html).toContain("尚未提供");
  expect(html).toContain("实际调用权限以请求时的确认为准");
  expect(html).toContain("名称已截短");
  expect(html).toContain("说明已截短");
});
it("reports truncation without changing the returned count to the displayed subset", () => {
  const html = renderToStaticMarkup(
    <SessionToolsReportView
      report={{ ...report, reportedItemCount: 400, itemsTruncated: true }}
    />,
  );
  expect(html).toContain("程序本次返回 400 项工具信息");
  expect(html).toContain("部分工具信息未展示");
  expect(html).toContain("报告完整性未提供");
});
it("renders opening extension diagnostics separately from present connection or call results", () => {
  const html = renderToStaticMarkup(
    <SessionToolStartupView
      report={{
        reportedCount: 257,
        loadedCount: 253,
        failedCount: 1,
        unknownCount: 2,
      }}
    />,
  );
  expect(html).toContain("打开对话时的扩展加载报告");
  expect(html).toContain("程序报告 257 项结果");
  expect(html).toContain("报告加载成功 253 项");
  expect(html).toContain("报告加载失败 1 项");
  expect(html).toContain("结果无法确认 2 项");
  expect(html).toContain("部分加载结果未统计");
  expect(html).not.toContain("已连接");
  expect(html).not.toContain("调用成功");
});
