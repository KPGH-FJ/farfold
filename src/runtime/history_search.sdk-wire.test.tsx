import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import wire from "../../docs/evidence/2026-10-09-capability-hardening/claude-history/backend/actual-wire.json";
import {
  parseHistoryReply,
  parseHistorySelection,
  type HistorySearchExpected,
} from "./history_search_types";
import { HistorySearchController } from "./history_search_controller";
import {
  HistorySearchResults,
  HistorySearchText,
} from "../components/HistorySearchResults";
import { deferred, flush } from "./history_search.test-support";
import { HISTORY_SEARCH_STRINGS as S } from "./history_search_strings";
const base = wire.running.operation;
const expected: HistorySearchExpected = {
  agentId: base.agentId,
  requestId: base.requestId,
  selectionId: base.selectionId,
  query: base.query,
  rowIds: base.rowIds,
};
it.each(Object.entries(wire).filter(([key]) => key !== "capabilityShape"))(
  "preserves actual SDK-source Rust serialization %s without fabricating a turn locator",
  (_key, value) => {
    const identity = "operation" in value ? value.operation : base;
    expect(
      parseHistoryReply(
        value,
        {
          agentId: identity.agentId,
          requestId: identity.requestId,
          selectionId: identity.selectionId,
          query: identity.query,
          rowIds: identity.rowIds,
        },
        "officialSdk",
      ),
    ).toEqual(value);
  },
);
it("preserves the actual serialized capability shape without claiming an official capability invocation", () => {
  expect(
    parseHistorySelection(wire.capabilityShape, base.agentId, base.rowIds),
  ).toEqual(wire.capabilityShape);
});
it("same owned-child running and completed values drive the real controller and shared snapshot renderer", async () => {
  const start = deferred(),
    status = deferred();
  const port = {
    // This capability was serialized by Rust, not obtained from a real official installation.
    capabilities: vi.fn().mockResolvedValue(wire.capabilityShape),
    start: vi.fn(() => start.promise),
    status: vi.fn(() => status.promise),
    cancel: vi.fn(),
    release: vi.fn().mockResolvedValue(true),
  };
  const owner = { agentId: base.agentId, current: () => true };
  const controller = new HistorySearchController(port, () => base.requestId);
  expect(await controller.prepare(owner, base.rowIds)).toBe(true);
  expect(controller.start(owner, base.query)).toBe(true);
  start.resolve(wire.running);
  await flush();
  expect(controller.get(base.agentId).flight?.operation).toEqual(base);
  controller.check(base.agentId, base.requestId);
  status.resolve(wire.completed);
  await flush();
  const op = controller.get(base.agentId).flight!.operation!;
  expect(op).toEqual(wire.completed.operation);
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={op}
      title={() => "Selected history"}
      onPreview={vi.fn()}
    />,
  );
  expect(html).toContain(S.registeredScope);
  expect(html).toContain(S.errors.coverageUnconfirmed);
  expect(html).not.toContain(S.rowStates.complete);
  expect(
    renderToStaticMarkup(<HistorySearchText hit={op.hits[0]} />),
  ).toContain("<mark>");
  expect(port.start).toHaveBeenCalledTimes(1);
  expect(port.cancel).not.toHaveBeenCalled();
});
it.each(["empty", "sourceChanged"] as const)(
  "actual %s does not become a successful complete empty-history claim",
  (key) => {
    const value = wire[key],
      op = value.operation;
    const parsed = parseHistoryReply(
      value,
      {
        agentId: op.agentId,
        requestId: op.requestId,
        selectionId: op.selectionId,
        query: op.query,
        rowIds: op.rowIds,
      },
      "officialSdk",
    );
    if (parsed.kind !== "operation") throw new Error("expected operation");
    const html = renderToStaticMarkup(
      <HistorySearchResults
        operation={parsed.operation}
        title={() => "Selected history"}
        onPreview={vi.fn()}
      />,
    );
    expect(html).not.toContain(S.rowStates.complete);
    expect(html).not.toContain('history-search-hit"');
    expect(html).toContain(
      key === "empty" ? S.errors.sourceUnconfirmed : S.errors.sourceChanged,
    );
  },
);
