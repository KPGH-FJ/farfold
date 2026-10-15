import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));

import { threads, groupSidebarRows, type IndexRow } from "./sessions";
import { draftPersistence } from "./drafts";
import { canDrain } from "./queue";
import { configChangeBusy } from "./protected_config";
import { updateConversationBlocker } from "./update_impact";
import { authenticationWorkBlockers } from "./auth_blockers";
import { receiveCompactionActivity } from "./compaction_activity";

const channel = threads as unknown as {
  applyChannelEvent(key: string, event: unknown, live?: boolean): void;
};

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  invoke.mockImplementation(async (command: string) =>
    command === "session_prompt"
      ? { status: "accepted" }
      : command === "settings_get"
        ? null
        : [],
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
});

function seed(id: string) {
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  s.connectionId = `connection-${id}`;
  return s;
}
function activity(
  s: ReturnType<typeof seed>,
  ids = ["live"],
  uncertain = false,
) {
  return {
    kind: "compactionActivity",
    connectionId: s.connectionId,
    sessionId: s.nativeSessionId,
    compactionIds: ids,
    uncertain,
  };
}
function endingWithCompaction(id: string) {
  const s = seed(id);
  s.running = true;
  channel.applyChannelEvent(s.key, {
    update: {
      sessionUpdate: "compaction_update",
      compactionId: "live",
      status: "in_progress",
    },
  });
  channel.applyChannelEvent(s.key, activity(s));
  channel.applyChannelEvent(s.key, { kind: "turnEnd", stopReason: "end_turn" });
  return s;
}

it("keeps live compaction protected after the ordinary request ends", () => {
  const s = endingWithCompaction("compaction-tail-guards");
  s.queued = [[{ type: "text", text: "Preserve queued text" }]];
  // Explicit continuation must still pass current work admission.
  s.queuePaused = null;
  expect(s.running).toBe(false);
  expect(canDrain(s)).toBe(false);
  expect(configChangeBusy(s)).toBe(true);
  expect(updateConversationBlocker(s)).not.toBeNull();
  expect(s.queued[0]?.[0]).toEqual({
    type: "text",
    text: "Preserve queued text",
  });
});

it("does not dispatch an explicit follow-up while compaction is still active", async () => {
  const s = endingWithCompaction("compaction-tail-follow-up");
  await threads.send(s.key, [{ type: "text", text: "Keep this new input" }]);
  expect(
    invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(s.queued).toEqual([[{ type: "text", text: "Keep this new input" }]]);
});

it("records an unknown outcome when the independent compaction connection is lost", () => {
  const s = endingWithCompaction("compaction-tail-lost");
  channel.applyChannelEvent(s.key, { kind: "connectionLost" });
  expect(s.connectionOutcomeUnknown).toBe(true);
  expect(threads.needsAttention(s)).toBe(true);
});

it("never treats actual process end as successful compaction completion", () => {
  const s = endingWithCompaction("compaction-tail-process-end");
  channel.applyChannelEvent(s.key, {
    ...activity(s, []),
    reason: "process_ended",
  });
  expect(s.connectionOutcomeUnknown).toBe(true);
  expect(s.items.find((item) => item.kind === "compaction")).toMatchObject({
    status: "in_progress",
  });
});

it("protects an unresolved activity receipt even without a usable card", () => {
  const s = seed("compaction-unresolved-envelope");
  channel.applyChannelEvent(s.key, activity(s, [], true));
  expect(configChangeBusy(s)).toBe(true);
  expect(updateConversationBlocker(s)).not.toBeNull();
});

it("does not infer live work from replayed cards or an earlier owner's metadata", () => {
  const s = seed("compaction-replay");
  channel.applyChannelEvent(
    s.key,
    {
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "historical",
        status: "in_progress",
      },
    },
    false,
  );
  channel.applyChannelEvent(s.key, {
    ...activity(s),
    connectionId: "old-owner",
  });
  expect(configChangeBusy(s)).toBe(false);
  s.queued = [[{ type: "text", text: "Allowed new request" }]];
  expect(canDrain(s)).toBe(true);
});

it("accepts current backend activity buffered before the open reply instead of treating it as raw history", () => {
  const s = seed("compaction-buffered-live-owner");
  channel.applyChannelEvent(s.key, activity(s), false);
  expect(configChangeBusy(s)).toBe(true);
});

it("does not auto-continue a paused queue when the last compaction really ends", () => {
  const s = endingWithCompaction("compaction-terminal-queue");
  s.queued = [[{ type: "text", text: "Still paused" }]];
  const pause = s.queuePaused;
  channel.applyChannelEvent(s.key, {
    update: {
      sessionUpdate: "compaction_update",
      compactionId: "live",
      status: "completed",
    },
  });
  channel.applyChannelEvent(s.key, activity(s, []));
  expect(s.queuePaused).toBe(pause);
  expect(
    invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("keeps a compaction-only tail reachable in the running list", () => {
  const s = endingWithCompaction("compaction-tail-sidebar");
  s.queuePaused = null;
  const row: IndexRow = {
    id: s.key,
    agentId: s.agentId,
    cwd: s.cwd,
    nativeSessionId: s.nativeSessionId,
    title: "Controlled compaction",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    configOptions: null,
  };
  expect(
    groupSidebarRows([row], new Map([[s.key, s]]))[0]?.rows[0]?.status,
  ).toBe("run");
});

it("cannot clear a lost compaction outcome with a late turn receipt or activity snapshot", () => {
  const s = endingWithCompaction("compaction-ended-late-receipt");
  channel.applyChannelEvent(s.key, {
    ...activity(s, []),
    reason: "process_ended",
  });
  channel.applyChannelEvent(s.key, { kind: "turnEnd", stopReason: "end_turn" });
  channel.applyChannelEvent(s.key, activity(s, []));
  expect(s.connectionOutcomeUnknown).toBe(true);
  expect(configChangeBusy(s)).toBe(true);
  expect(threads.needsAttention(s)).toBe(true);
  s.queued = [[{ type: "text", text: "Preserve after lost work" }]];
  s.queuePaused = null;
  expect(canDrain(s)).toBe(false);
});

it("cannot release a paused queue while compaction still owns work", async () => {
  const s = endingWithCompaction("compaction-continue-admission");
  s.queued = [[{ type: "text", text: "Keep this explicitly paused" }]];
  const pause = s.queuePaused;
  await threads.continueQueue(s.key);
  expect(s.queuePaused).toBe(pause);
  expect(s.queued).toEqual([
    [{ type: "text", text: "Keep this explicitly paused" }],
  ]);
});

it("keeps independent compaction uncertainty after loss even if a late ordinary ending arrives", () => {
  const s = endingWithCompaction("compaction-lost-late-turn");
  channel.applyChannelEvent(s.key, { kind: "connectionLost" });
  channel.applyChannelEvent(s.key, { kind: "turnEnd", stopReason: "end_turn" });
  expect(s.connectionOutcomeUnknown).toBe(true);
});

it("rechecks activity after saving input and before actual dispatch", async () => {
  const s = seed("compaction-during-save");
  let release!: () => void;
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(draftPersistence.flush).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      }),
  );
  const pending = threads.send(s.key, [
    { type: "text", text: "Keep the original pending input" },
  ]);
  await saving;
  expect(release).toBeTypeOf("function");
  channel.applyChannelEvent(s.key, activity(s));
  release();
  await expect(pending).resolves.toMatchObject({ status: "rejected" });
  expect(
    invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(s.queued).toEqual([
    [{ type: "text", text: "Keep the original pending input" }],
  ]);
});

it.each([
  { compactionIds: ["live", "live"] },
  { compactionIds: [""] },
  { compactionIds: ["bad\0id"] },
  { compactionIds: [42] },
  { compactionIds: "live" },
  { uncertain: null },
  { sessionId: "another-session" },
  { connectionId: "earlier-connection" },
  { reason: "unverified-exit" },
])(
  "retains current protection when activity metadata is invalid or not owned: %j",
  (patch) => {
    const s = endingWithCompaction(
      `compaction-invalid-${JSON.stringify(patch)}`,
    );
    expect(receiveCompactionActivity(s, { ...activity(s, []), ...patch })).toBe(
      false,
    );
    expect(configChangeBusy(s)).toBe(true);
  },
);

it("blocks shared account changes while leaving another conversation's local work independent", () => {
  const a = endingWithCompaction("compaction-owner-a");
  const b = seed("compaction-owner-b");
  b.queued = [[{ type: "text", text: "Independent input" }]];
  expect(canDrain(b)).toBe(true);
  expect(configChangeBusy(b)).toBe(false);
  expect(
    authenticationWorkBlockers(a.agentId, [a, b]).map((blocker) => blocker.key),
  ).toEqual([a.key]);
  expect(receiveCompactionActivity(a, activity(b, []))).toBe(false);
  expect(configChangeBusy(a)).toBe(true);
});

it("retains current ownership when a receipt exceeds the backend identity bounds", () => {
  const s = endingWithCompaction("compaction-receipt-bounds");
  for (const ids of [
    Array.from({ length: 513 }, (_, i) => `id-${i}`),
    ["a".repeat(4097)],
    ["甲".repeat(1366)],
  ]) {
    expect(receiveCompactionActivity(s, activity(s, ids))).toBe(false);
    expect(configChangeBusy(s)).toBe(true);
  }
});
