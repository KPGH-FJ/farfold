import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parseHistoryReply,
  parseHistorySelection,
  type HistorySearchOperation,
} from "./history_search_types";
import {
  expected,
  flush,
  operation,
  setup,
} from "./history_search.test-support";
import { sdkOperation, sdkSelection } from "./history_search.sdk.test-support";
import { HISTORY_SEARCH_STRINGS as S } from "./history_search_strings";
import {
  HistorySearchResults,
  HistorySearchText,
} from "../components/HistorySearchResults";

it("accepts only the declared registered-ID partial capability and real message locator", () => {
  const cap = sdkSelection();
  expect(parseHistorySelection(cap, expected.agentId, expected.rowIds)).toEqual(
    cap,
  );
  const wire = sdkOperation();
  const hit = wire.operation.hits[0];
  hit.role = "assistant";
  hit.messageLocator.partIndex = 2;
  hit.text = "🙂hello <script>private</script>";
  hit.matches = [{ start: 2, end: 7 }];
  expect(parseHistoryReply(wire, expected, "officialSdk")).toEqual(wire);
  const html = renderToStaticMarkup(<HistorySearchText hit={hit as never} />);
  expect(html).toContain("🙂<mark>hello</mark>");
  expect(html).not.toContain("<script>");
});

it.each([
  [
    "legacy source with new fields",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation, { source: "officialAppServer" }),
  ],
  [
    "wrong scope",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation, { scope: "allHistory" }),
  ],
  [
    "claimed continuity",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation, { continuation: "verified" }),
  ],
  [
    "claimed complete coverage",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation, { coverage: "complete" }),
  ],
  [
    "proposal relation is not final contract",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation, { relation: "indexedNativeId" }),
  ],
  [
    "complete row",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation.rows[0], { state: "complete", code: null }),
  ],
  [
    "legacy hit",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation, {
        hits: operation("completed").operation.hits,
      }),
  ],
  [
    "mixed locator",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation.hits[0], { turnId: "fake" }),
  ],
  [
    "non-UUID message",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation.hits[0].messageLocator, { messageId: "fake" }),
  ],
  [
    "wrong locator kind",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation.hits[0].messageLocator, { kind: "turnItem" }),
  ],
  [
    "unsafe part index",
    (w: ReturnType<typeof sdkOperation>) =>
      Object.assign(w.operation.hits[0].messageLocator, {
        partIndex: Number.MAX_SAFE_INTEGER + 1,
      }),
  ],
  [
    "duplicate message block",
    (w: ReturnType<typeof sdkOperation>) =>
      w.operation.hits.push(structuredClone(w.operation.hits[0])),
  ],
] as const)("rejects cross-source or contradictory %s", (_, mutate) => {
  const wire = sdkOperation();
  mutate(wire);
  expect(() => parseHistoryReply(wire, expected, "officialSdk")).toThrow();
});

it("does not let a legacy response replace the route granted by a new capability", () => {
  expect(() =>
    parseHistoryReply(operation("completed"), expected, "officialSdk"),
  ).toThrow();
  expect(() =>
    parseHistoryReply(sdkOperation(), expected, "officialAppServer"),
  ).toThrow();
});

it("keeps legacy capability strict and requires every partial-route declaration", () => {
  const capability = sdkSelection();
  for (const key of [
    "coverage",
    "relation",
    "continuation",
    "branch",
  ] as const) {
    const missing = { ...capability } as Record<string, unknown>;
    delete missing[key];
    expect(() =>
      parseHistorySelection(missing, expected.agentId, expected.rowIds),
    ).toThrow();
  }
  expect(() =>
    parseHistorySelection(
      { ...capability, source: "officialAppServer" },
      expected.agentId,
      expected.rowIds,
    ),
  ).toThrow();
});

it("fixes the capability route for the flight without sending implementation fields in start", async () => {
  const h = setup();
  h.port.capabilities.mockResolvedValue(sdkSelection());
  expect(await h.prepare()).toBe(true);
  expect(h.controller.start(h.owner, "hello")).toBe(true);
  expect(h.port.start).toHaveBeenCalledWith({
    agentId: expected.agentId,
    requestId: expected.requestId,
    selectionId: expected.selectionId,
    query: "hello",
  });
  h.start.resolve(sdkOperation());
  await flush();
  expect(h.controller.get("fixture").flight?.operation?.hits).toHaveLength(1);
});

it("retiring a partial-route owner discards late bodies while keeping exact cancellation tracking", async () => {
  const h = setup();
  h.port.capabilities.mockResolvedValue(sdkSelection());
  await h.prepare();
  h.controller.start(h.owner, "hello");
  h.close();
  expect(h.port.cancel).toHaveBeenCalledWith({
    agentId: expected.agentId,
    requestId: expected.requestId,
  });
  h.start.resolve(sdkOperation());
  await flush();
  expect(h.controller.get("fixture").flight?.operation?.hits).toEqual([]);
  expect(h.controller.get("fixture").flight?.owner).toBeNull();
});

it("shows a partial registered-ID result without promising the current branch or continuation", () => {
  const op = sdkOperation().operation as unknown as HistorySearchOperation;
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={op}
      title={() => "Selected"}
      onPreview={vi.fn()}
    />,
  );
  expect(html).toContain("已保存记录");
  expect(html).toContain("当前分支");
  expect(html).toContain("后续继续");
  expect(html).not.toContain("本次范围读取完成");
  expect(html).not.toContain("SDK");
});

it.each(["sourceUnconfirmed", "sourceChanged", "sourceTooLarge"] as const)(
  "keeps %s as an unread/failed scope, never a complete empty result",
  (code) => {
    const wire = sdkOperation("failed");
    Object.assign(wire.operation, { code });
    Object.assign(wire.operation.rows[0], {
      code,
      pagesRead: 0,
      textBlocksRead: 0,
      matchedTextBlocks: 0,
    });
    const parsed = parseHistoryReply(wire, expected, "officialSdk");
    if (parsed.kind !== "operation") throw new Error("expected operation");
    const html = renderToStaticMarkup(
      <HistorySearchResults
        operation={parsed.operation}
        title={() => "Selected"}
        onPreview={vi.fn()}
      />,
    );
    expect(html).toContain(S.errors[code]);
    expect(html).toContain(S.unreadText);
    expect(html).not.toContain(S.empty);
    expect(html).not.toContain(S.noText);
  },
);
it("keeps status and cancel on the captured source, refusing a cross-source late response", async () => {
  const h = setup();
  h.port.capabilities.mockResolvedValue(sdkSelection());
  await h.prepare();
  h.controller.start(h.owner, "hello");
  h.start.resolve(sdkOperation("running", 1));
  await flush();
  h.controller.check("fixture", expected.requestId);
  h.status.resolve(operation("completed", 99));
  await flush();
  expect(h.controller.get("fixture").flight?.operation?.source).toBe(
    "officialSdk",
  );
  expect(h.controller.get("fixture").flight?.operation?.revision).toBe(1);
  expect(h.controller.get("fixture").flight?.unconfirmed).toBe(true);
  h.controller.cancel("fixture", expected.requestId);
  h.cancel.resolve(sdkOperation("cancelled", 3));
  await flush();
  expect(h.controller.get("fixture").flight?.operation?.state).toBe(
    "cancelled",
  );
  expect(h.controller.get("fixture").flight?.unconfirmed).toBe(false);
});
it("shows returned text with no matches as partial, even after the operation settles", () => {
  const wire = sdkOperation();
  wire.operation.hits = [];
  wire.operation.rows[0].matchedTextBlocks = 0;
  const parsed = parseHistoryReply(wire, expected, "officialSdk");
  if (parsed.kind !== "operation") throw new Error("expected operation");
  const html = renderToStaticMarkup(
    <HistorySearchResults
      operation={parsed.operation}
      title={() => "Selected"}
      onPreview={vi.fn()}
    />,
  );
  expect(html).toContain(S.partial);
  expect(html).toContain(S.empty);
  expect(html).not.toContain(S.rowStates.complete);
});
