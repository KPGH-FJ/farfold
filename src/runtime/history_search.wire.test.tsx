import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import wire from "../../docs/evidence/2026-10-09-capability-hardening/history-search/backend/actual-wire.json";
import {
  parseHistoryReply,
  parseHistorySelection,
  type HistorySearchExpected,
  type HistorySearchOperation,
} from "./history_search_types";
import { HistorySearchController } from "./history_search_controller";
import {
  HistorySearchResults,
  HistorySearchText,
} from "../components/HistorySearchResults";
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
)("strictly preserves actual Rust serialized %s", (_key, value) => {
  expect(parseHistoryReply(value, expected)).toEqual(value);
});
it("actual unsupported Agent capability does not become a usable token", () => {
  expect(
    parseHistorySelection(
      wire.capabilityUnavailable,
      base.agentId,
      base.rowIds,
    ),
  ).toEqual(wire.capabilityUnavailable);
  expect(wire.capabilityUnavailable.selectionId).toBeNull();
});
it("same actual Rust running/completed replies drive the real controller and readable context without a restore", async () => {
  const next = deferred(),
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
    start: vi.fn(() => next.promise),
    status: vi.fn(() => status.promise),
    cancel: vi.fn(),
    release: vi.fn().mockResolvedValue(true),
  };
  // Admission fixture is controlled; operations below are untouched actual Rust values.
  const owner = { agentId: base.agentId, current: () => true };
  const controller = new HistorySearchController(port, () => base.requestId);
  await controller.prepare(owner, base.rowIds);
  expect(controller.start(owner, base.query)).toBe(true);
  next.resolve(wire.running);
  await flush();
  expect(controller.get(base.agentId).flight?.operation).toEqual(
    wire.running.operation,
  );
  controller.check(base.agentId, base.requestId);
  status.resolve(wire.completed);
  await flush();
  const op = controller.get(base.agentId).flight!.operation!;
  expect(op).toEqual(wire.completed.operation);
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={op}
      title={() => "Selected conversation"}
      onPreview={vi.fn()}
    />,
  );
  expect(html).toContain("Selected conversation");
  expect(html).toContain("本次范围读取完成");
  expect(
    renderToStaticMarkup(<HistorySearchText hit={op.hits[0]} />),
  ).toContain("<mark>");
  expect(port.start).toHaveBeenCalledTimes(1);
  expect(port.cancel).not.toHaveBeenCalled();
});
it("actual partial result is shown as ended coverage with an explicit remaining boundary", () => {
  const partial = Object.values(wire).find(
    (v) =>
      "operation" in v && v.operation.rows.some((r) => r.state === "partial"),
  );
  expect(partial).toBeDefined();
  if (!partial || !("operation" in partial)) return;
  const op = parseHistoryReply(partial, expected);
  if (op.kind !== "operation") throw new Error("expected operation");
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={op.operation as HistorySearchOperation}
      title={() => "Selected conversation"}
      onPreview={vi.fn()}
    />,
  );
  expect(html).toContain("只读取了部分内容");
  expect(html).toContain("本次未能检索全部所选内容");
});
