import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { applyUpdate, freshThreadState } from "./session_projection";
import {
  isReportedArtifactCurrent,
  reportedArtifactCount,
  reportedArtifactCounts,
  reportedArtifactFiles,
  scopedArtifactToolItems,
} from "./reported_artifacts";
import { reportedFiles } from "./file_delivery";
import type { ThreadState } from "./session_types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const state = () => freshThreadState("a:/work:one", "a", "/work", "one");
function report(
  s: ThreadState,
  id = "one",
  fields: Record<string, unknown> = {},
) {
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: id,
    kind: "edit",
    status: "completed",
    locations: [{ path: "report.md" }],
    ...fields,
  });
  return s.items.find(
    (item) => item.kind === "tool" && item.call.toolCallId === id,
  )!;
}
function end(s: ThreadState, id: string, ids: string[]) {
  s.items.push({
    id,
    kind: "settled",
    status: "done",
    diffCount: 0,
    artifactCount: 0,
    artifactToolItemIds: ids,
    time: 1,
  });
}
function update(s: ThreadState, id: string, fields: Record<string, unknown>) {
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    ...fields,
  });
}

it("aggregates completed files with all distinct sources and no body or disk authority", () => {
  const s = state();
  const first = report(s, "one", {
    content: [
      { type: "diff", path: "report.md", oldText: null, newText: "BODY" },
      { type: "diff", path: "report.md", oldText: null, newText: "BODY" },
      {
        type: "content",
        content: {
          type: "resource_link",
          name: "report",
          uri: "file:///work/chart%20one.png",
        },
      },
    ],
  });
  const second = report(s, "two");
  const files = reportedArtifactFiles(s, null)!;
  expect(files.map((f) => f.path)).toEqual([
    "report.md",
    "/work/chart one.png",
  ]);
  expect(files[0].origins).toEqual([
    { toolItemId: first.id, toolCallId: "one", source: "diff" },
    { toolItemId: first.id, toolCallId: "one", source: "location" },
    { toolItemId: second.id, toolCallId: "two", source: "location" },
  ]);
  expect(JSON.stringify(files)).not.toContain("BODY");
  expect(Object.isFrozen(files[0].origins[0])).toBe(true);
  expect(Object.isFrozen(files[0].origins)).toBe(true);
  expect(Object.isFrozen(files[0])).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
  if (first.kind !== "tool") throw new Error("Expected tool");
  // Existing single-candidate API remains compatible.
  expect(reportedFiles(first.call).map((f) => f.source)).toEqual([
    "diff",
    "resourceLink",
  ]);
});

it.each(["pending", "in_progress", "failed", "cancelled", "unknown"])(
  "never promotes %s calls into a completed report",
  (status) => {
    const s = state();
    report(s, "one", { status });
    expect(reportedArtifactFiles(s, null)).toEqual([]);
  },
);
it.each(["read", "search", "execute", "delete"])(
  "does not turn %s locations or raw input into files",
  (kind) => {
    const s = state();
    report(s, "one", {
      kind,
      rawInput: { path: "guess.md", content: "BODY" },
      content: [
        {
          type: "content",
          content: { type: "text", text: "Saved /work/guess.md" },
        },
      ],
    });
    expect(reportedArtifactFiles(s, null)).toEqual([]);
  },
);
it("excludes embedded resources and remote/ambiguous links", () => {
  const s = state();
  report(s, "one", {
    kind: "execute",
    locations: [],
    content: [
      {
        type: "content",
        content: {
          type: "resource",
          resource: { uri: "file:///work/embedded.md", text: "BODY" },
        },
      },
      ...[
        "https://example.com/a",
        "file://remote/a",
        "file:///a?x=1",
        "file:///a#b",
        "file:///a%00",
        "file:///a%ZZ",
      ].map((uri) => ({
        type: "content",
        content: { type: "resource_link", name: "one", uri },
      })),
    ],
  });
  expect(reportedArtifactFiles(s, null)).toEqual([]);
});
it("keeps case, Unicode and unverified path aliases distinct", () => {
  const s = state();
  [
    "a.md",
    "A.md",
    "/work/a.md",
    "./a.md",
    "é.md",
    "e\u0301.md",
    "a/../a.md",
    "output",
  ].forEach((path, i) => report(s, String(i), { locations: [{ path }] }));
  const files = reportedArtifactFiles(s, null)!;
  expect(files).toHaveLength(8);
  expect(files.at(-1)?.key).not.toBe("output");
});
it("uses exact step/round references and keeps late completion in the original scope", () => {
  const s = state();
  const old = report(s, "old", { status: "in_progress" });
  end(s, "round-old", [old.id]);
  const next = report(s, "new", { locations: [{ path: "new.md" }] });
  end(s, "round-new", [next.id]);
  expect(reportedArtifactFiles(s, "round-old")).toEqual([]);
  update(s, "old", { status: "completed" });
  expect(reportedArtifactFiles(s, "round-old")?.map((f) => f.path)).toEqual([
    "report.md",
  ]);
  expect(reportedArtifactFiles(s, "round-new")?.map((f) => f.path)).toEqual([
    "new.md",
  ]);
  expect(scopedArtifactToolItems(s, old.id)).toEqual([old]);
  expect(reportedArtifactFiles(s, "missing")).toBeNull();
  s.items = s.items.filter((item) => item !== old);
  expect(reportedArtifactFiles(s, "round-old")).toBeNull();
  expect(reportedArtifactCount(s, "round-old")).toBeNull();
});
it("rechecks current collection replacement, preserving null-as-omission", () => {
  const s = state();
  report(s);
  const entry = reportedArtifactFiles(s, null)![0];
  update(s, "one", { locations: null });
  expect(isReportedArtifactCurrent(s, null, entry)).toBe(true);
  update(s, "one", { locations: [] });
  expect(isReportedArtifactCurrent(s, null, entry)).toBe(false);
  expect(reportedArtifactFiles(s, null)).toEqual([]);
});
it.each([
  "thread",
  "cwd",
  "scope",
  "clone",
  "item",
  "call",
  "status",
  "new-origin",
])("rejects an old or fabricated entry after %s changes", (change) => {
  const s = state();
  const item = report(s);
  end(s, "round", [item.id]);
  const entry = reportedArtifactFiles(s, "round")![0];
  let target = s;
  let scope: string | null = "round";
  let candidate = entry;
  if (change === "thread") target = { ...s };
  if (change === "cwd") s.cwd = "/other";
  if (change === "scope") scope = null;
  if (change === "clone") candidate = { ...entry };
  if (change === "item") s.items[0] = { ...item };
  if (change === "call" && item.kind === "tool") item.call = { ...item.call };
  if (change === "status") update(s, "one", { status: "failed" });
  if (change === "new-origin")
    update(s, "one", {
      content: [
        { type: "diff", path: "report.md", oldText: null, newText: "NEW" },
      ],
    });
  expect(isReportedArtifactCurrent(target, scope, candidate)).toBe(false);
});
it("rejects replacement scope objects and ambiguous item IDs", () => {
  const s = state();
  const item = report(s);
  end(s, "round", [item.id]);
  const entry = reportedArtifactFiles(s, "round")![0];
  s.items[1] = { ...s.items[1] };
  expect(isReportedArtifactCurrent(s, "round", entry)).toBe(false);
  s.items.push({ ...item });
  expect(scopedArtifactToolItems(s, null)).toBeNull();
});
it("counts reported paths and diffs once, plus only nonempty outputs", () => {
  const s = state();
  report(s, "one", {
    content: [{ type: "diff", path: "report.md", oldText: null, newText: "A" }],
  });
  report(s, "two");
  report(s, "failed", {
    status: "failed",
    locations: [],
    rawInput: { path: "proposed.md", content: "NOT A RESULT" },
  });
  report(s, "empty-command", { kind: "execute", locations: [] });
  report(s, "command", { kind: "execute", locations: [], rawOutput: "LOG" });
  expect(reportedArtifactCount(s, null)).toBe(3);
  expect(reportedArtifactFiles(s, null)?.map((f) => f.path)).toEqual([
    "report.md",
  ]);
});

it("bulk counts match exact live scopes, including duplicates and missing references", () => {
  const s = state();
  const a = report(s, "a");
  const b = report(s, "b");
  const c = report(s, "c", {
    kind: "execute",
    locations: [],
    rawOutput: "LOG",
  });
  end(s, "round", [a.id, b.id, b.id, c.id]);
  end(s, "missing", ["gone"]);
  end(s, "empty", []);
  const counts = reportedArtifactCounts(s);
  expect(counts.get("round")).toBe(2);
  expect(counts.get("missing")).toBeNull();
  expect(counts.get("empty")).toBe(0);
  for (const item of s.items)
    expect(counts.get(item.id)).toBe(reportedArtifactCount(s, item.id));
});
it("reads each tool report once for many transcript counts", () => {
  const s = state();
  for (let i = 0; i < 1000; i++) report(s, String(i));
  end(
    s,
    "round",
    s.items.map((item) => item.id),
  );
  let locationReads = 0;
  for (const item of s.items) {
    if (item.kind !== "tool") continue;
    const locations = item.call.locations;
    Object.defineProperty(item.call, "locations", {
      get: () => {
        locationReads++;
        return locations;
      },
    });
  }
  const counts = reportedArtifactCounts(s);
  expect(counts.size).toBe(1001);
  expect(counts.get("round")).toBe(1);
  expect(locationReads).toBe(1000);
});
