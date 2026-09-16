import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  contentSnapshot,
  contentHistory,
  contentEvent as event,
  contentBatch,
  contentNativeTurn,
  contentContext,
} from "../../scripts/fixtures/codex-transcript-data";
import {
  CodexAcpTranscriptReader,
  projectAcpTranscript,
} from "./codex-acp-transcript";
import {
  contentEvent,
  checkedItem,
  requestCodexAcpHistory,
} from "./codex-acp-content";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const ipc = vi.mocked(invoke);
beforeEach(() => {
  ipc.mockReset();
});
const live = () => [
  event(1, { kind: "started" }),
  event(2, {
    kind: "item_started",
    item: { type: "agentMessage", id: "message", text: "" },
  }),
  event(3, {
    kind: "delta",
    itemId: "message",
    channel: "item/agentMessage/delta",
    delta: "实时正文",
    index: null,
  }),
];
it("projects scoped text/reasoning/items and terminal without changing Host state", () => {
  const s = contentSnapshot();
  const raw = [
    ...live(),
    event(4, {
      kind: "item_started",
      item: { type: "reasoning", id: "reasoning", summary: [], content: [] },
    }),
    event(5, {
      kind: "delta",
      itemId: "reasoning",
      channel: "item/reasoning/summaryTextDelta",
      delta: "安全摘要",
      index: 0,
    }),
    event(6, {
      kind: "item_completed",
      item: { type: "commandExecution", id: "command", status: "completed" },
    }),
    event(7, { kind: "terminal", status: "completed" }),
  ];
  const parsed = raw.map((e) => contentEvent(e, s)!);
  const p = projectAcpTranscript(
    null,
    [...parsed, parsed[2]],
    true,
    "有限事件",
  );
  expect(p.turns).toHaveLength(1);
  expect(p.turns[0].items).toEqual([
    { type: "agentMessage", id: "message", text: "实时正文" },
    { type: "reasoning", id: "reasoning", summary: ["安全摘要"], content: [] },
    { type: "commandExecution", id: "command", status: "completed" },
  ]);
  expect(p.turns[0].status).toBe("completed");
  expect(p.incomplete).toBe(true);
  expect(s.activeTurn).toBeNull();
  expect(s.capabilities.submitTurn).toBe(false);
});
it("history supersedes overlapping live item text without duplicating it", async () => {
  const h = contentHistory();
  h.turns = [
    {
      nativeTurnId: contentNativeTurn,
      status: "completed",
      items: [{ type: "agentMessage", id: "message", text: "历史最终正文" }],
    },
  ];
  ipc.mockResolvedValueOnce(contentBatch(0, live()));
  const r = await new CodexAcpTranscriptReader().read(
    contentSnapshot(),
    async () => h,
  );
  expect(r.turns).toHaveLength(1);
  expect(r.turns[0].hostTurnId).toBeNull();
  expect(r.turns[0].source).toBe("history");
  expect(r.turns[0].items[0]).toMatchObject({ text: "历史最终正文" });
  expect(ipc).toHaveBeenCalledExactlyOnceWith("runtime_event_snapshot", {
    afterSequence: 0,
    limit: 512,
  });
});
it("reads bounded terminal history through original operation and rejects private extras", async () => {
  const h = contentHistory();
  h.turns = [
    {
      nativeTurnId: contentNativeTurn,
      status: "completed",
      items: [{ type: "commandExecution", id: "command", status: "completed" }],
    },
  ];
  ipc.mockResolvedValueOnce({ kind: "history", snapshot: h });
  await expect(
    requestCodexAcpHistory(h.scope, h.farfoldSessionId),
  ).resolves.toEqual(h);
  ipc.mockResolvedValueOnce({
    kind: "history",
    snapshot: {
      ...h,
      turns: [
        {
          ...h.turns[0],
          items: [{ ...h.turns[0].items[0], command: "PRIVATE" }],
        },
      ],
    },
  });
  await expect(
    requestCodexAcpHistory(h.scope, h.farfoldSessionId),
  ).rejects.toThrow("历史尚未核对");
});
it("rejects wrong tree, turn identity conflicts, and unrecognized content", () => {
  const s = contentSnapshot();
  const e = event(1, { kind: "started" });
  const wrong = structuredClone(e);
  (
    wrong.nativeEnvelope as any
  ).payload.params.turn.context.thread.nativeSessionId = "foreign";
  expect(() => contentEvent(wrong, s)).toThrow();
  expect(contentEvent({ ...e, connectionId: "foreign" }, s)).toBeNull();
  expect(() =>
    checkedItem({
      type: "commandExecution",
      id: "x",
      status: "completed",
      diff: "PRIVATE",
    }),
  ).toThrow();
  const a = contentEvent(e, s)!;
  const p = projectAcpTranscript(
    null,
    [a, { ...a, sequence: 2, hostTurnId: "foreign" }],
    false,
    "",
  );
  expect(p.incomplete).toBe(true);
  expect(p.turns).toHaveLength(1);
});
it("gap is sticky in live view and repeated batches do not duplicate text", async () => {
  const reader = new CodexAcpTranscriptReader(),
    s = contentSnapshot();
  s.activeTurn = {
    context: contentContext(),
    nativeTurnId: contentNativeTurn,
    stopRequested: false,
  };
  const batch = contentBatch(0, live());
  ipc.mockResolvedValueOnce({
    ...batch,
    gap: {
      requestedAfter: 0,
      oldestAvailable: 1,
      latestSequence: 3,
      droppedTotal: 1,
    },
  });
  const history = vi.fn();
  const first = await reader.read(s, history);
  expect(first.incomplete).toBe(true);
  ipc.mockResolvedValueOnce({ ...contentBatch(3, live()), requestedAfter: 3 });
  const again = await reader.read(s, history);
  expect(again.turns).toEqual(first.turns);
  expect(history).not.toHaveBeenCalled();
});
it("terminal history refresh is read-only and never resends a prompt", async () => {
  const reader = new CodexAcpTranscriptReader(),
    s = contentSnapshot();
  s.activeTurn = {
    context: contentContext(),
    nativeTurnId: contentNativeTurn,
    stopRequested: false,
  };
  ipc.mockResolvedValueOnce(
    contentBatch(0, [
      ...live(),
      event(4, { kind: "terminal", status: "completed" }),
    ]),
  );
  const h = contentHistory();
  h.before.latestSequence = 4;
  h.turns = [
    {
      nativeTurnId: contentNativeTurn,
      status: "completed",
      items: [{ type: "agentMessage", id: "message", text: "历史最终正文" }],
    },
  ];
  const history = vi.fn(async () => h);
  await reader.read(s, history);
  ipc.mockResolvedValueOnce(contentBatch(4, []));
  s.activeTurn = null;
  const result = await reader.read(s, history);
  expect(history).toHaveBeenCalledTimes(1);
  expect(result.turns[0].source).toBe("history");
  expect(ipc.mock.calls.every((c) => c[0] === "runtime_event_snapshot")).toBe(
    true,
  );
});
it("does not reuse old content for another unknown Session", async () => {
  const reader = new CodexAcpTranscriptReader(),
    s = contentSnapshot();
  ipc.mockResolvedValueOnce(contentBatch(0, live()));
  await reader.read(s, async () => contentHistory());
  const other = contentSnapshot();
  other.target!.farfoldSessionId = "other";
  other.connectionState = "unknown";
  const result = await reader.read(other, async () => contentHistory());
  expect(result.turns).toEqual([]);
});
it("late history receipt cannot overwrite a newer scope read", async () => {
  const reader = new CodexAcpTranscriptReader();
  let release!: (v: ReturnType<typeof contentHistory>) => void;
  const first = reader.read(
    contentSnapshot(),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const next = contentSnapshot();
  next.scope!.generation = 2;
  const h = contentHistory();
  h.scope.generation = 2;
  ipc.mockResolvedValueOnce(contentBatch(0, []));
  await reader.read(next, async () => h);
  release(contentHistory());
  await expect(first).rejects.toThrow();
  expect(ipc).toHaveBeenCalledTimes(1);
});
it("preserves validated 256-byte native item IDs", () => {
  expect(
    checkedItem({ type: "agentMessage", id: "a".repeat(256), text: "safe" }),
  ).toMatchObject({ text: "safe" });
});

it("disconnect never means cancellation or restores continuity on the next read", async () => {
  const reader = new CodexAcpTranscriptReader(),
    s = contentSnapshot();
  ipc.mockResolvedValueOnce(contentBatch(0, live()));
  await reader.read(s, async () => contentHistory());
  const disconnected = await reader.read(
    { ...s, connectionState: "unknown" },
    async () => contentHistory(),
  );
  expect(disconnected.turns[0].status).toBe("inProgress");
  expect(disconnected.incomplete).toBe(true);
  ipc.mockResolvedValueOnce(contentBatch(3, []));
  expect((await reader.read(s, async () => contentHistory())).incomplete).toBe(
    true,
  );
});
it("stream replacement freezes the view and does not retry or combine another stream", async () => {
  const reader = new CodexAcpTranscriptReader(),
    s = contentSnapshot();
  ipc.mockResolvedValueOnce(contentBatch(0, live()));
  const old = await reader.read(s, async () => contentHistory());
  ipc.mockResolvedValueOnce({
    ...contentBatch(3, []),
    streamId: "foreign-stream",
  });
  const result = await reader.read(s, async () => contentHistory());
  expect(result.turns).toEqual(old.turns);
  expect(result.incomplete).toBe(true);
  await reader.read(s, async () => contentHistory());
  expect(ipc).toHaveBeenCalledTimes(2);
});
it("closing retires a pending read before it can request router data; return uses a new reader", async () => {
  const reader = new CodexAcpTranscriptReader();
  let release!: (h: ReturnType<typeof contentHistory>) => void;
  const pending = reader.read(
    contentSnapshot(),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  reader.retire();
  release(contentHistory());
  await expect(pending).rejects.toThrow("退休");
  expect(ipc).not.toHaveBeenCalled();
  ipc.mockResolvedValueOnce(contentBatch(0, live()));
  const s = contentSnapshot();
  s.activeTurn = {
    context: contentContext(),
    nativeTurnId: contentNativeTurn,
    stopRequested: false,
  };
  const result = await new CodexAcpTranscriptReader().read(s, async () =>
    contentHistory(),
  );
  expect(result.turns[0].items[0]).toMatchObject({ text: "实时正文" });
  expect(result.incomplete).toBe(true);
});
