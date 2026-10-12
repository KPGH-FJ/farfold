import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import wire from "../../docs/evidence/2026-10-09-capability-hardening/history-search/backend/final-wire.json";
import {
  parseHistoryReply,
  parseHistorySelection,
  type HistorySearchExpected,
} from "./history_search_types";
import { HistorySearchController } from "./history_search_controller";
import { HistorySearchResults } from "../components/HistorySearchResults";
import { deferred, flush } from "./history_search.test-support";
const base = wire.running.operation;
const expected: HistorySearchExpected = {
  agentId: base.agentId,
  requestId: base.requestId,
  selectionId: base.selectionId,
  query: base.query,
  rowIds: base.rowIds,
};
it.each(
  Object.entries(wire).filter(([key]) => key !== "capabilityUnavailable"),
)("strictly preserves final actual Rust %s", (_key, value) => {
  expect(parseHistoryReply(value, expected)).toEqual(value);
});
it("final actual unavailable capability retains its exact reasons", () => {
  expect(
    parseHistorySelection(
      wire.capabilityUnavailable,
      base.agentId,
      base.rowIds,
    ),
  ).toEqual(wire.capabilityUnavailable);
});
it.each(["readingUnconfirmed", "sourceDrift"] as const)(
  "%s reports discovered but not publishable text without claiming no match",
  (key) => {
    const reply = parseHistoryReply(wire[key], expected);
    if (reply.kind !== "operation") throw new Error("operation required");
    const html = renderToStaticMarkup(
      <HistorySearchResults
        operation={reply.operation}
        title={() => "Selected conversation"}
        onPreview={vi.fn()}
      />,
    );
    expect(html).toContain("2 段匹配");
    expect(html).not.toContain("在已检索文字中没有匹配内容");
    expect(html).not.toContain("0 处匹配");
    expect(html).toContain("匹配内容尚未确认");
    expect(html).toContain("可查看的匹配文字");
    expect(html).not.toContain('history-search-hit"');
  },
);
it("same actual unpublished-reading to source-drift chain stays unavailable in the real controller", async () => {
  const start = deferred(),
    status = deferred();
  const port = {
    capabilities: vi.fn().mockResolvedValue({
      agentId: base.agentId,
      selectionId: base.selectionId,
      validForMs: 300000,
      source: "officialAppServer",
      scope: "userAndAssistantText",
      availability: "available",
      code: null,
      rows: base.rowIds.map((rowId) => ({
        rowId,
        availability: "available",
        code: null,
      })),
    }),
    start: vi.fn(() => start.promise),
    status: vi.fn(() => status.promise),
    cancel: vi.fn(),
    release: vi.fn(),
  };
  const owner = { agentId: base.agentId, current: () => true };
  const controller = new HistorySearchController(port, () => base.requestId);
  await controller.prepare(owner, base.rowIds);
  controller.start(owner, base.query);
  start.resolve(wire.readingUnconfirmed);
  await flush();
  expect(controller.get(base.agentId).flight?.operation).toEqual(
    wire.readingUnconfirmed.operation,
  );
  controller.check(base.agentId, base.requestId);
  status.resolve(wire.sourceDrift);
  await flush();
  expect(controller.get(base.agentId).flight?.operation).toEqual(
    wire.sourceDrift.operation,
  );
  expect(controller.get(base.agentId).flight?.operation?.hits).toEqual([]);
  expect(port.start).toHaveBeenCalledTimes(1);
});
