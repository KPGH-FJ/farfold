import { vi } from "vitest";
import {
  HistorySearchController,
  type HistorySearchOwner,
} from "./history_search_controller";
import type {
  HistorySearchExpected,
  HistorySearchOperation,
  HistorySearchReply,
  HistorySearchSelection,
} from "./history_search_types";
export const requestId = "00000000-0000-4000-8000-000000000001";
export const selectionId = "00000000-0000-4000-8000-000000000002";
export const expected: HistorySearchExpected = {
  agentId: "fixture",
  requestId,
  selectionId,
  rowIds: ["saved-1"],
  query: "hello",
};
export function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
export function selection(): HistorySearchSelection {
  return {
    agentId: "fixture",
    selectionId,
    validForMs: 300000,
    availability: "available",
    source: "officialAppServer",
    scope: "userAndAssistantText",
    code: null,
    rows: [{ rowId: "saved-1", availability: "available", code: null }],
  };
}
export function operation(
  state: HistorySearchOperation["state"] = "running",
  revision = 0,
  identity = expected,
): HistorySearchReply & { kind: "operation" } {
  const settled = ["completed", "cancelled", "failed"].includes(state);
  return {
    kind: "operation",
    operation: {
      ...identity,
      rowIds: [...identity.rowIds],
      revision,
      state,
      settled,
      code:
        state === "cancelled" || state === "cancelling"
          ? "cancelled"
          : state === "pendingCleanup"
            ? "pendingCleanup"
            : state === "failed"
              ? "queryFailed"
              : null,
      source: "officialAppServer",
      scope: "userAndAssistantText",
      matchMode: "unicodeLowercaseLiteral",
      exclusions: [
        "attachments",
        "toolOutput",
        "reasoning",
        "otherMessageKinds",
      ],
      rows: identity.rowIds.map((rowId) => ({
        rowId,
        state:
          state === "completed"
            ? "complete"
            : state === "cancelled"
              ? "skipped"
              : state === "failed"
                ? "failed"
                : "reading",
        pagesRead: settled ? 1 : 0,
        textBlocksRead: settled ? 1 : 0,
        matchedTextBlocks: state === "completed" ? 1 : 0,
        code:
          state === "cancelled"
            ? "cancelled"
            : state === "failed"
              ? "queryFailed"
              : null,
      })),
      hits:
        state === "completed"
          ? [
              {
                rowId: identity.rowIds[0],
                turnId: "turn-1",
                itemId: "item-1",
                partIndex: 0,
                role: "user",
                text: "hello <script>PRIVATE_BODY</script>",
                textTruncated: false,
                matches: [{ start: 0, end: 5 }],
                matchesTruncated: false,
              },
            ]
          : [],
    },
  };
}
export function setup() {
  const start = deferred(),
    status = deferred(),
    cancel = deferred(),
    capability = deferred();
  const port = {
    capabilities: vi.fn().mockResolvedValue(selection()),
    start: vi.fn(() => start.promise),
    status: vi.fn(() => status.promise),
    cancel: vi.fn(() => cancel.promise),
    release: vi.fn().mockResolvedValue(true),
  };
  let nextRequest = 1;
  let current = true,
    now = 0;
  const owner: HistorySearchOwner = {
    agentId: "fixture",
    current: () => current,
  };
  const controller = new HistorySearchController(
    port,
    () => `00000000-0000-4000-8000-${String(nextRequest++).padStart(12, "0")}`,
    () => now,
    100,
  );
  const prepare = () => controller.prepare(owner, expected.rowIds);
  return {
    controller,
    port,
    owner,
    start,
    status,
    cancel,
    capability,
    prepare,
    close() {
      current = false;
      controller.retire(owner);
    },
    setTime(value: number) {
      now = value;
    },
  };
}
