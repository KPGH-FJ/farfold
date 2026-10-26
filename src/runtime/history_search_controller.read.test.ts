import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock("./history_import", async (original) => ({
  ...(await original<typeof import("./history_import")>()),
  closeHistoryPreview: h.close,
}));
import { HistorySearchController } from "./history_search_controller";
import type {
  HistoryReadInput,
  HistoryReadOperation,
  HistoryReadTarget,
} from "./history_search_types";
import { deferred, flush } from "./history_search.test-support";

const targets: HistoryReadTarget[] = [1, 2].map((n) => ({
  rowId: `saved-${n}`,
  agentId: "fixture",
  cwd: "/owned",
  nativeSessionId: `native-${n}`,
  unavailable: null,
}));
function operation(input: HistoryReadInput): HistoryReadOperation {
  return {
    agentId: input.agentId,
    requestId: input.requestId,
    query: input.query,
    rowIds: input.targets.map((target) => target.rowId),
    source: "officialSessionLoad",
    scope: "userAndAssistantText",
    coverageScope: "acknowledgedLoadPrefix",
    textScope: "returnedVisibleFields",
    matchMode: "ecmascriptUnicodeLiteral",
    exclusions: ["attachments", "toolOutput", "reasoning", "otherMessageKinds"],
    state: "finished",
    settled: true,
    code: null,
    rows: input.targets.map((target) => ({
      rowId: target.rowId,
      coverage: "completeReturnedPrefix",
      textBlocksRead: 1,
      matchedTextBlocks: 1,
      skippedFields: 0,
      sourceStatus: "sourceUnconfirmed",
      code: null,
    })),
    hits: [
      {
        rowId: input.targets[0].rowId,
        role: "assistant",
        text: "hello from the returned prefix",
        textTruncated: false,
        matches: [{ start: 0, end: 5 }],
        matchesTruncated: false,
        locator: { kind: "returnedText", blockIndex: 0, fieldIndex: 0 },
      },
    ],
    pendingCleanup: null,
  };
}
function setup() {
  const result = deferred<HistoryReadOperation>();
  let input!: HistoryReadInput;
  const read = vi.fn((next: HistoryReadInput) => {
    input = next;
    return result.promise;
  });
  const port = {
    capabilities: vi.fn(),
    start: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(),
    release: vi.fn(),
  };
  const controller = new HistorySearchController(
    port,
    () => "00000000-0000-4000-8000-000000000003",
    () => 0,
    100,
    read,
  );
  let current = true;
  const owner = { agentId: "fixture", current: () => current };
  const start = () => controller.startRead(owner, "hello", targets);
  const flight = () => controller.get("fixture").flight!;
  return {
    controller,
    owner,
    port,
    read,
    result,
    start,
    flight,
    input: () => input,
    setCurrent(value: boolean) {
      current = value;
    },
  };
}
beforeEach(() => {
  h.close.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("uses one selected-read flight and never polls or cancels the native search worker", async () => {
  const t = setup();
  expect(t.start()).toBe(true);
  expect(t.start()).toBe(false);
  expect(t.input().targets).toEqual(targets);
  expect(t.input().targets).not.toBe(targets);
  t.controller.check("fixture", t.input().requestId);
  t.controller.cancel("fixture", t.input().requestId);
  expect(t.input().signal.aborted).toBe(true);
  for (const method of Object.values(t.port))
    expect(method).not.toHaveBeenCalled();
  t.result.resolve(operation(t.input()));
  await flush();
  expect(t.flight().operation?.hits).toEqual([]);
  expect(await t.controller.dismiss("fixture", t.input().requestId)).toBe(true);
  expect(t.port.release).not.toHaveBeenCalled();
});

it("retires sticky A-B-A interest and drops late text without replaying another row", async () => {
  const t = setup();
  t.start();
  t.setCurrent(false);
  expect(t.input().current()).toBe(false);
  t.setCurrent(true);
  expect(t.input().current()).toBe(false);
  t.input().onProgress({
    ...operation(t.input()),
    state: "reading",
    settled: false,
  });
  t.result.resolve(operation(t.input()));
  await flush();
  expect(t.flight().owner).toBeNull();
  expect(t.flight().operation?.hits).toEqual([]);
  expect(t.read).toHaveBeenCalledTimes(1);
  expect(t.port.cancel).not.toHaveBeenCalled();
});

it("unknown invoke failure stays unsettled and cannot release or restart through another route", async () => {
  const t = setup();
  t.start();
  t.input().onProgress({
    ...operation(t.input()),
    state: "reading",
    settled: false,
  });
  t.result.reject(new Error("PRIVATE_CONTROLLED_ERROR"));
  await flush();
  expect(t.flight().unconfirmed).toBe(true);
  expect(t.flight().operation).toMatchObject({
    state: "unconfirmed",
    settled: false,
    code: "unavailable",
    pendingCleanup: null,
    hits: [],
  });
  expect(JSON.stringify(t.flight())).not.toContain("PRIVATE_CONTROLLED_ERROR");
  expect(await t.controller.dismiss("fixture", t.input().requestId)).toBe(
    false,
  );
  expect(t.start()).toBe(false);
  t.controller.check("fixture", t.input().requestId);
  expect(h.close).not.toHaveBeenCalled();
  for (const method of Object.values(t.port))
    expect(method).not.toHaveBeenCalled();
});

it("retries only the same exact cleanup receipt after an explicit action and never resumes the batch", async () => {
  const t = setup();
  t.start();
  const op = operation(t.input());
  op.state = "pendingCleanup";
  op.settled = false;
  op.code = "pendingCleanup";
  op.pendingCleanup = {
    rowId: "saved-1",
    receipt: {
      agentId: "fixture",
      cwd: "/owned",
      nativeSessionId: "native-1",
      previewToken: "owned-token",
    },
  };
  t.result.resolve(op);
  await flush();
  expect(await t.controller.dismiss("fixture", t.input().requestId)).toBe(
    false,
  );
  expect(t.start()).toBe(false);
  const closing = deferred<void>();
  h.close.mockReturnValueOnce(closing.promise);
  const pending = t.controller.retryReadClose("fixture", t.input().requestId);
  expect(
    await t.controller.retryReadClose("fixture", t.input().requestId),
  ).toBe(false);
  expect(h.close).toHaveBeenCalledExactlyOnceWith(op.pendingCleanup.receipt);
  closing.reject(new Error("controlled close failure"));
  expect(await pending).toBe(false);
  expect(t.flight().operation?.settled).toBe(false);
  expect(h.close).toHaveBeenCalledTimes(1);
  h.close.mockResolvedValueOnce(undefined);
  expect(
    await t.controller.retryReadClose("fixture", t.input().requestId),
  ).toBe(true);
  expect(t.flight().operation).toMatchObject({
    settled: true,
    state: "finished",
    pendingCleanup: null,
  });
  expect(t.read).toHaveBeenCalledTimes(1);
  expect(h.close.mock.calls[1]).toEqual([op.pendingCleanup.receipt]);
  t.input().onProgress(op);
  expect(t.flight().operation?.settled).toBe(true);
  expect(t.flight().operation?.source).toBe("officialSessionLoad");
  expect(t.port.release).not.toHaveBeenCalled();
});

it("cannot exact-close a pending progress receipt until its original runner has returned", async () => {
  const t = setup();
  t.start();
  const op = operation(t.input());
  op.state = "pendingCleanup";
  op.settled = false;
  op.pendingCleanup = {
    rowId: "saved-1",
    receipt: {
      agentId: "fixture",
      cwd: "/owned",
      nativeSessionId: "native-1",
      previewToken: "owned-token",
    },
  };
  t.input().onProgress(op);
  expect(
    await t.controller.retryReadClose("fixture", t.input().requestId),
  ).toBe(false);
  expect(h.close).not.toHaveBeenCalled();
  t.result.resolve(op);
  await flush();
});

it("synchronous retirement before dispatch never calls the read runner", async () => {
  const t = setup();
  const off = t.controller.subscribe(() => {
    if (t.controller.get("fixture").flight) t.controller.retire(t.owner);
  });
  expect(t.start()).toBe(false);
  off();
  expect(t.read).not.toHaveBeenCalled();
  expect(t.flight().operation).toMatchObject({ settled: true, hits: [] });
  expect(h.close).not.toHaveBeenCalled();
});
