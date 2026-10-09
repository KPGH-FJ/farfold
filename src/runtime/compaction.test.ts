import { expect, it } from "vitest";
import {
  applyConnectionLost,
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import { hasAgentReply, settledRoundResults } from "./round_result";
import type { ThreadState } from "./session_types";

const state = () => freshThreadState("a:/p:s", "a", "/p", "s");
const update = (compactionId: string, status: string, patch = {}) => ({
  sessionUpdate: "compaction_update",
  compactionId,
  status,
  ...patch,
});
const chunk = (compactionId: string, content: unknown) => ({
  sessionUpdate: "compaction_summary_chunk",
  compactionId,
  content,
});
const text = (value: string) => ({ type: "text" as const, text: value });
type View = {
  kind: string;
  id: string;
  compactionId: string;
  status: string;
  summary: unknown[];
  error?: string;
  meta?: unknown;
  observation?: string;
};
const views = (s: ThreadState) =>
  (s.items as unknown as View[]).filter((i) => i.kind === "compaction");

it("upserts one entity in its original position without splitting the surrounding identified message", () => {
  const s = state();
  applyUpdate(s, {
    sessionUpdate: "agent_message_chunk",
    messageId: "m",
    content: text("Before "),
  });
  applyUpdate(s, update("c", "in_progress"));
  const id = views(s)[0]?.id;
  applyUpdate(s, {
    sessionUpdate: "agent_message_chunk",
    messageId: "m",
    content: text("after"),
  });
  applyUpdate(s, update("c", "completed"));
  expect(s.items.map((i) => i.kind)).toEqual(["agent", "compaction"]);
  expect(s.items[0]).toMatchObject({ text: "Before after" });
  expect(views(s)).toMatchObject([
    { id, compactionId: "c", status: "completed" },
  ]);
});

it("preserves streaming blocks, replaces final summary, and distinguishes omitted/null/empty patches", () => {
  const s = state();
  applyUpdate(s, update("c", "in_progress", { _meta: { first: true } }));
  applyUpdate(s, chunk("c", text("one")));
  applyUpdate(
    s,
    chunk("c", {
      type: "resource_link",
      name: "file",
      uri: "file:///p/result.md",
    }),
  );
  applyUpdate(s, update("c", "completed"));
  expect(views(s)[0]).toMatchObject({
    summary: [text("one"), { type: "resource_link" }],
    meta: { first: true },
  });
  applyUpdate(
    s,
    update("c", "completed", {
      summary: [text("final")],
      _meta: { second: true },
    }),
  );
  expect(views(s)[0]).toMatchObject({
    summary: [text("final")],
    meta: { second: true },
  });
  applyUpdate(s, update("c", "completed", { summary: null, _meta: null }));
  expect(views(s)[0]?.summary).toEqual([]);
  expect(views(s)[0]?.meta).toBeUndefined();
  applyUpdate(s, update("c", "completed", { summary: [text("replacement")] }));
  applyUpdate(s, update("c", "completed", { summary: [] }));
  expect(views(s)[0]?.summary).toEqual([]);
});

it.each(["completed", "failed", "cancelled", "_future_state"])(
  "supports first-seen %s without inventing a start",
  (status) => {
    const s = state();
    applyUpdate(s, update("c", status));
    expect(views(s)).toMatchObject([{ status, summary: [] }]);
  },
);

it("patches and clears failure text; partial summary remains explicitly separate from success", () => {
  const s = state();
  applyUpdate(s, update("c", "in_progress"));
  applyUpdate(s, chunk("c", text("partial")));
  applyUpdate(s, update("c", "failed", { error: "service refused" }));
  applyUpdate(s, update("c", "failed"));
  expect(views(s)[0]).toMatchObject({
    status: "failed",
    error: "service refused",
    summary: [text("partial")],
  });
  applyUpdate(s, update("c", "failed", { error: null }));
  expect(views(s)[0]?.error).toBeUndefined();
});

it("does not borrow the same opaque id from another conversation", () => {
  const a = state(),
    b = state();
  applyUpdate(a, update("same", "in_progress"));
  applyUpdate(b, update("same", "completed"));
  expect(views(a)[0]?.status).toBe("in_progress");
  expect(views(b)[0]?.status).toBe("completed");
});

it("keeps multiple lifecycle identities ordered and never makes a partially finished group successful", () => {
  const s = state();
  applyUpdate(s, update("one", "in_progress"));
  applyUpdate(s, update("two", "in_progress"));
  applyUpdate(s, update("one", "completed"));
  expect(applyTurnEnd(s, { stopReason: "end_turn" })).toBe(
    "maintenance_pending",
  );
  applyUpdate(s, update("two", "failed", { error: "second failed" }));
  expect(settledRoundResults(s).get(s.items.at(-1)!.id)).toBe(
    "maintenance_failed",
  );
  expect(views(s).map((v) => v.compactionId)).toEqual(["one", "two"]);
});

it.each([
  { sessionUpdate: "compaction_update", status: "completed" },
  {
    sessionUpdate: "compaction_update",
    compactionId: null,
    status: "completed",
  },
  { sessionUpdate: "compaction_update", compactionId: "c", status: 1 },
  update("c", "in_progress", { summary: [text("not retained")] }),
  update("c", "completed", { error: "not a failure" }),
  update("c", "completed", { summary: "bad" }),
  chunk("orphan", text("orphan")),
])(
  "retains invalid/unsupported updates raw without fabricating an entity: %j",
  (value) => {
    const s = state();
    applyUpdate(s, value);
    expect(views(s)).toHaveLength(0);
    expect(s.items).toMatchObject([{ kind: "raw", update: value }]);
  },
);

it("preserves unknown block data but refuses late chunks and contradictory terminal transitions", () => {
  const s = state();
  applyUpdate(s, update("c", "in_progress"));
  const unknown = { type: "_future_media", payload: { value: 7 } };
  applyUpdate(s, chunk("c", unknown));
  applyUpdate(s, update("c", "completed"));
  applyUpdate(s, chunk("c", text("late")));
  applyUpdate(s, update("c", "failed", { error: "contradiction" }));
  expect(views(s)[0]).toMatchObject({
    status: "completed",
    summary: [unknown],
  });
  expect(s.items.filter((i) => i.kind === "raw")).toHaveLength(2);
});

it("never interprets a turn receipt or a context usage decrease as compaction completion", () => {
  const s = state();
  applyUpdate(s, update("c", "in_progress"));
  applyUpdate(s, { sessionUpdate: "usage_update", used: 2, size: 100 });
  applyTurnEnd(s, { stopReason: "end_turn" });
  expect(views(s)[0]?.status).toBe("in_progress");
  expect(settledRoundResults(s).get(s.items.at(-1)!.id)).toBe(
    "maintenance_pending",
  );
});

it("marks interrupted observation unknown without rewriting reported status or a completed entity", () => {
  const s = state();
  applyUpdate(s, update("pending", "in_progress"));
  applyUpdate(s, update("done", "completed"));
  applyConnectionLost(s);
  expect(views(s)[0]).toMatchObject({
    status: "in_progress",
    observation: "unknown",
  });
  expect(views(s)[1]?.observation).toBeUndefined();
  applyUpdate(s, update("pending", "completed"));
  expect(views(s)[0]?.observation).toBeUndefined();
});

it.each(["completed", "failed", "cancelled", "_future_state"])(
  "keeps compaction-only %s separate from replies/artifacts and pauses queued work",
  (status) => {
    const s = state();
    s.running = true;
    s.queued = [[text("Next")]];
    applyUpdate(
      s,
      update(
        "c",
        status,
        status === "completed" ? { summary: [text("not a reply")] } : {},
      ),
    );
    const result = applyTurnEnd(s, { stopReason: "end_turn" });
    expect(result).toBe(
      status === "completed"
        ? "maintenance"
        : status === "failed" || status === "cancelled"
          ? "maintenance_failed"
          : "maintenance_unknown",
    );
    expect(hasAgentReply(s.items)).toBe(false);
    expect(s.items.at(-1)).toMatchObject({
      replyReceived: false,
      artifactCount: 0,
    });
    expect(s.queuePaused).not.toBeNull();
    expect(s.queued).toHaveLength(1);
  },
);

it("keeps late completion with its original round without resuming or lending it to the next round", () => {
  const s = state();
  applyUpdate(s, update("old", "in_progress"));
  applyTurnEnd(s, { stopReason: "end_turn" });
  const old = s.items.at(-1)!.id;
  s.roundItemBase = s.items.length;
  applyTurnEnd(s, { stopReason: "end_turn" });
  const next = s.items.at(-1)!.id;
  applyUpdate(s, update("old", "completed"));
  expect(settledRoundResults(s).get(old)).toBe("maintenance");
  expect(settledRoundResults(s).get(next)).toBe("none");
  expect(s.queuePaused).not.toBeNull();
});

it.each(["cancelled", "refusal"])(
  "does not let successful compaction override round %s",
  (stopReason) => {
    const s = state();
    applyUpdate(s, update("c", "completed"));
    applyTurnEnd(s, { stopReason });
    expect(s.items.at(-1)).toMatchObject({
      status: stopReason === "cancelled" ? "stopped" : "failed",
    });
    expect(views(s)[0]?.status).toBe("completed");
  },
);

it.each(["in_progress", "failed", "cancelled", "_future"])(
  "does not auto-drain a reply's queue when its compaction remains %s",
  (status) => {
    const s = state();
    s.running = true;
    s.queued = [[text("Next")]];
    applyUpdate(s, {
      sessionUpdate: "agent_message_chunk",
      content: text("Actual answer"),
    });
    applyUpdate(s, update("c", status));
    expect(applyTurnEnd(s, { stopReason: "end_turn" })).toBe("reply");
    expect(s.queuePaused).not.toBeNull();
  },
);

it("allows an answered request with completed compaction, without carrying old failed entities forward", () => {
  const s = state();
  applyUpdate(s, update("old", "failed"));
  s.roundItemBase = s.items.length;
  applyUpdate(s, update("current", "completed"));
  applyUpdate(s, {
    sessionUpdate: "agent_message_chunk",
    content: text("Actual answer"),
  });
  expect(applyTurnEnd(s, { stopReason: "end_turn" })).toBe("reply");
  expect(s.queuePaused).toBeNull();
});

it.each([undefined, "same"])(
  "compaction is transparent to message streaming with id %s but user/tool/end still separate messages",
  (messageId) => {
    const s = state();
    const message = (value: string) => ({
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: text(value),
    });
    applyUpdate(s, message("one"));
    applyUpdate(s, update("c", "in_progress"));
    applyUpdate(s, message("two"));
    applyUpdate(s, { sessionUpdate: "tool_call", toolCallId: "t" });
    applyUpdate(s, message("three"));
    expect(
      s.items.filter((i) => i.kind === "agent").map((i) => i.text),
    ).toEqual(["onetwo", "three"]);
  },
);
