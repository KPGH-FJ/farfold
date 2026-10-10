import { describe, expect, it } from "vitest";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import {
  isReportedArtifactCurrent,
  reportedArtifactCount,
  reportedArtifactFiles,
  scopedArtifactToolItems,
} from "./reported_artifacts";
import type { ThreadState } from "./session_types";

const path = "/controlled/report one.md";
const resource = (uri = "file:///controlled/report%20one.md") => ({
  type: "content",
  content: { type: "resource_link", name: "Report", uri },
});
const state = () =>
  freshThreadState(
    "independent:/controlled:p19",
    "independent",
    "/controlled",
    "p19",
  );
function emit(s: ThreadState, id: string, fields: Record<string, unknown>) {
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    ...fields,
  });
}
function settle(s: ThreadState) {
  applyTurnEnd(s, { stopReason: "end_turn" });
  const item = s.items.at(-1)!;
  if (item.kind !== "settled")
    throw new Error("Expected actual settled projection");
  s.roundItemBase = s.items.length;
  return item;
}
function one(s: ThreadState, scope: string | null) {
  const files = reportedArtifactFiles(s, scope);
  expect(files).toHaveLength(1);
  return files![0];
}

describe("independent actual protocol projection to reported-file scope", () => {
  it("keeps late completion and explicit withdrawal with their original settled round", () => {
    const s = state();
    s.running = true;
    s.queued = [[{ type: "text", text: "Retained, never sent" }]];
    emit(s, "old", {
      kind: "edit",
      status: "in_progress",
      locations: [{ path }],
    });
    s.activeToolCallIds = ["old"];
    const oldRound = settle(s);
    expect(reportedArtifactFiles(s, oldRound.id)).toEqual([]);
    expect(s.queuePaused).toBe("stopped");
    emit(s, "new", {
      kind: "execute",
      status: "completed",
      content: [resource()],
    });
    const newRound = settle(s);
    const newerEntry = one(s, newRound.id);
    const queued = s.queued;
    const paused = s.queuePaused;
    emit(s, "old", { status: "completed" });
    expect(one(s, oldRound.id).origins.map((o) => o.toolCallId)).toEqual([
      "old",
    ]);
    expect(one(s, newRound.id).origins.map((o) => o.toolCallId)).toEqual([
      "new",
    ]);
    expect(one(s, null).origins.map((o) => o.toolCallId)).toEqual([
      "old",
      "new",
    ]);
    expect(isReportedArtifactCurrent(s, newRound.id, newerEntry)).toBe(true);
    emit(s, "old", { locations: [] });
    expect(reportedArtifactFiles(s, oldRound.id)).toEqual([]);
    expect(reportedArtifactCount(s, oldRound.id)).toBe(0);
    expect(one(s, null).origins.map((o) => o.toolCallId)).toEqual(["new"]);
    expect(s.queued).toBe(queued);
    expect(s.queuePaused).toBe(paused);
  });

  it("treats v1 null as omission, but clears content and locations independently with []", () => {
    const s = state();
    emit(s, "mixed", {
      kind: "edit",
      status: "completed",
      locations: [{ path }],
      content: [resource()],
      rawInput: {
        path: "/controlled/input-only.md",
        content: "Not a completed report",
      },
    });
    const round = settle(s);
    expect(one(s, round.id).origins.map((o) => o.source)).toEqual([
      "resourceLink",
      "location",
    ]);
    emit(s, "mixed", { locations: null, content: null });
    expect(one(s, round.id).origins.map((o) => o.source)).toEqual([
      "resourceLink",
      "location",
    ]);
    emit(s, "mixed", { content: [] });
    expect(one(s, round.id).origins.map((o) => o.source)).toEqual(["location"]);
    emit(s, "mixed", { locations: [] });
    expect(reportedArtifactFiles(s, round.id)).toEqual([]);
    // The existing input-diff view remains distinct; it does not fabricate a reported file.
    expect(reportedArtifactCount(s, round.id)).toBe(1);
  });

  it("preserves same-tool and cross-tool origins without conflating unverified aliases", () => {
    const s = state();
    emit(s, "mixed", {
      kind: "edit",
      status: "completed",
      locations: [{ path }, { path }],
      content: [
        { type: "diff", path, oldText: null, newText: "Reported" },
        resource(),
        resource(),
      ],
    });
    emit(s, "second", {
      kind: "move",
      status: "completed",
      locations: [{ path }, { path: "report one.md" }],
    });
    const round = settle(s);
    const files = reportedArtifactFiles(s, round.id)!;
    expect(files.map((file) => file.path)).toEqual([path, "report one.md"]);
    expect(files[0].origins.map((o) => [o.toolCallId, o.source])).toEqual([
      ["mixed", "diff"],
      ["mixed", "resourceLink"],
      ["mixed", "location"],
      ["second", "location"],
    ]);
    expect(reportedArtifactCount(s, round.id)).toBe(2);
  });

  it("keeps scope membership across loaded-item reordering and refuses a missing original reference", () => {
    const s = state();
    emit(s, "a", { kind: "edit", status: "completed", locations: [{ path }] });
    const a = settle(s);
    emit(s, "b", {
      kind: "edit",
      status: "completed",
      locations: [{ path: "/controlled/later.md" }],
    });
    const b = settle(s);
    s.items.reverse();
    expect(one(s, a.id).path).toBe(path);
    expect(one(s, b.id).path).toBe("/controlled/later.md");
    a.artifactToolItemIds!.push(a.artifactToolItemIds![0]);
    expect(scopedArtifactToolItems(s, a.id)).toHaveLength(1);
    expect(one(s, a.id).origins).toHaveLength(1);
    s.items = s.items.filter(
      (item) => !a.artifactToolItemIds!.includes(item.id),
    );
    expect(reportedArtifactFiles(s, a.id)).toBeNull();
    expect(reportedArtifactCount(s, a.id)).toBeNull();
    expect(reportedArtifactFiles(s, "unknown-round")).toBeNull();
    expect(one(s, b.id).path).toBe("/controlled/later.md");
  });

  it("does not retroactively attach a newly observed unknown tool ID to a settled round", () => {
    const s = state();
    const before = settle(s);
    emit(s, "not-previously-observed", {
      kind: "edit",
      status: "completed",
      locations: [{ path }],
    });
    expect(reportedArtifactFiles(s, before.id)).toEqual([]);
    expect(reportedArtifactCount(s, before.id)).toBe(0);
    expect(one(s, null).path).toBe(path);
    // It appears only in the actually loaded projection until a later settled scope references it.
    const after = settle(s);
    expect(one(s, after.id).path).toBe(path);
  });

  it("rejects old actionable entries after real withdrawal, origin change, or exact-reference replacement", () => {
    const s = state();
    emit(s, "a", { kind: "edit", status: "completed", locations: [{ path }] });
    const round = settle(s);
    const entry = one(s, round.id);
    expect(isReportedArtifactCurrent(s, round.id, entry)).toBe(true);
    emit(s, "a", { locations: [], content: [resource()] });
    expect(isReportedArtifactCurrent(s, round.id, entry)).toBe(false);
    const current = one(s, round.id);
    const index = s.items.findIndex((item) => item.kind === "tool");
    const tool = s.items[index];
    if (tool.kind !== "tool") throw new Error("Expected original tool");
    s.items[index] = { ...tool, call: { ...tool.call } };
    expect(isReportedArtifactCurrent(s, round.id, current)).toBe(false);
    const after = one(s, round.id);
    expect(isReportedArtifactCurrent(s, round.id, { ...after })).toBe(false);
    expect(isReportedArtifactCurrent(s, null, after)).toBe(false);
    s.cwd = "/different";
    expect(isReportedArtifactCurrent(s, round.id, after)).toBe(false);
  });

  it("does not turn embedded resources, prose, failed/delete/read locations into reported files", () => {
    const s = state();
    for (const [id, fields] of Object.entries({
      failed: { kind: "edit", status: "failed", locations: [{ path }] },
      deleted: {
        kind: "delete",
        status: "completed",
        content: [{ type: "diff", path, oldText: "Gone", newText: "" }],
      },
      read: { kind: "read", status: "completed", locations: [{ path }] },
      embedded: {
        kind: "execute",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "resource",
              resource: {
                uri: "file:///controlled/embedded.md",
                text: "Embedded only",
              },
            },
          },
        ],
      },
      prose: {
        kind: "execute",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: `Saved ${path}` } },
        ],
      },
    }))
      emit(s, id, fields);
    expect(reportedArtifactFiles(s, settle(s).id)).toEqual([]);
  });
  it("keeps malformed location/diff data opaque while a later textual replacement becomes actionable", () => {
    const s = state();
    const badLocation = {
      path: { declared: "/controlled/not-a-path.md" },
      line: 0,
    };
    const badDiff = {
      type: "diff",
      path: 42,
      oldText: null,
      newText: "Opaque",
    };
    emit(s, "bad", {
      kind: "edit",
      status: "completed",
      locations: [badLocation],
      content: [badDiff],
    });
    const round = settle(s);
    expect(reportedArtifactFiles(s, round.id)).toEqual([]);
    const tool = scopedArtifactToolItems(s, round.id)![0];
    expect(tool.call.content).toEqual([{ type: "raw", value: badDiff }]);
    expect(tool.call.reportedDetails?.["/update/locations/0"]).toEqual(
      badLocation,
    );
    emit(s, "bad", { locations: null, content: null });
    expect(tool.call.reportedDetails?.["/update/locations/0"]).toEqual(
      badLocation,
    );
    emit(s, "bad", { locations: [{ path: "42" }], content: [] });
    expect(one(s, round.id).path).toBe("42");
    expect(tool.call.reportedDetails?.["/update/locations/0"]).toBeUndefined();
    emit(s, "bad", { locations: [] });
    expect(reportedArtifactFiles(s, round.id)).toEqual([]);
  });
});
