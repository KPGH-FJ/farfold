import { expect, it } from "vitest";
import { paneCards } from "./artifacts";
import { applySessionEvent } from "./session_event_projection";
import { applyUpdate, freshThreadState } from "./session_projection";
import { reportedArtifactFiles } from "./reported_artifacts";

const fields = {
  operation: "edit",
  path: "target",
  oldText: "previous",
  newText: "replacement",
};
function seed(status = "completed", id = "one") {
  const s = freshThreadState("file-input", "fixture", "/work", "one");
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: id,
    kind: "other",
    status,
    rawInput: {
      target: "/work/proof.txt",
      previous: "ALPHA",
      replacement: "BETA",
    },
    locations: [{ path: "/work/proof.txt", line: 1 }],
  });
  return s;
}
function present(s: ReturnType<typeof seed>, patch = {}) {
  applySessionEvent(
    s,
    {
      kind: "toolFileInput",
      source: "reported",
      toolCallId: "one",
      fields,
      ...patch,
    },
    false,
  );
}

it("projects declared input fields as an intent fragment and preserves the official call", () => {
  const s = seed();
  const original = structuredClone(s.items[0]);
  present(s);
  expect(paneCards(s)).toMatchObject([
    {
      kind: "diff",
      path: "/work/proof.txt",
      oldText: "ALPHA",
      newText: "BETA",
      scope: "fragment",
      source: "edit-input",
      status: "completed",
    },
  ]);
  expect(s.items[0]).toMatchObject(original);
  expect(reportedArtifactFiles(s, null)).toMatchObject([
    {
      path: "/work/proof.txt",
      origins: [{ toolCallId: "one", source: "location" }],
    },
  ]);
});

it.each(["failed", "pending", "in_progress"])(
  "keeps %s intent out of completed file sources",
  (status) => {
    const s = seed(status);
    s.running = true;
    s.activeToolCallIds = ["one"];
    present(s);
    expect(paneCards(s)).toMatchObject([{ source: "edit-input", status }]);
    expect(reportedArtifactFiles(s, null)).toEqual([]);
    s.activeToolCallIds = [];
    if (status !== "failed") expect(paneCards(s)[0].status).toBe("unknown");
  },
);

it("keeps distinct edits to the same path and explicit diff content takes precedence", () => {
  const s = seed();
  present(s);
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "two",
    kind: "other",
    status: "completed",
    rawInput: {
      target: "/work/proof.txt",
      previous: "BETA",
      replacement: "GAMMA",
    },
    locations: [{ path: "/work/proof.txt" }],
  });
  present(s, { toolCallId: "two" });
  expect(paneCards(s).map((c) => c.kind === "diff" && c.newText)).toEqual([
    "BETA",
    "GAMMA",
  ]);
  const files = reportedArtifactFiles(s, null)!;
  expect(files).toHaveLength(1);
  expect(files[0].origins.map((o) => o.toolCallId)).toEqual(["one", "two"]);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "one",
    content: [
      {
        type: "diff",
        path: "/work/proof.txt",
        oldText: "OFFICIAL BEFORE",
        newText: "OFFICIAL AFTER",
      },
    ],
  });
  expect(paneCards(s)).toHaveLength(2);
  expect(paneCards(s)[0]).toMatchObject({
    source: "diff",
    newText: "OFFICIAL AFTER",
  });
});

it("requires a declared format and clears it when a new input replaces the old shape", () => {
  const s = seed();
  expect(paneCards(s)).toEqual([]);
  present(s);
  expect(paneCards(s)).toHaveLength(1);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "one",
    rawInput: {
      target: "/work/proof.txt",
      previous: "UNCLASSIFIED",
      replacement: "UNCLASSIFIED",
    },
  });
  expect(paneCards(s)).toEqual([]);
  expect(reportedArtifactFiles(s, null)).toEqual([]);
  present(s);
  expect(paneCards(s)).toHaveLength(1);
  present(s, { fields: null });
  expect(paneCards(s)).toEqual([]);
});

it("does not guess malformed, foreign, read, or undeclared input formats", () => {
  for (const patch of [
    { toolCallId: "foreign" },
    { source: "future" },
    { fields: { ...fields, operation: "read" } },
    { fields: { ...fields, newText: 3 } },
    { fields: { ...fields, oldText: undefined } },
    { fields: { ...fields, path: "missing" } },
  ]) {
    const s = seed();
    present(s, patch);
    expect(paneCards(s)).toEqual([]);
    expect(reportedArtifactFiles(s, null)).toEqual([]);
  }
  const s = seed();
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "one",
    kind: "read",
  });
  present(s);
  expect(paneCards(s)).toEqual([]);
  expect(reportedArtifactFiles(s, null)).toEqual([]);
});

it("keeps empty replacement/write bodies and never uses an input path as a completed file report", () => {
  const s = seed();
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "one",
    rawInput: { target: "/work/proof.txt", previous: "ALPHA", replacement: "" },
    locations: [],
  });
  present(s);
  expect(paneCards(s)).toMatchObject([
    { oldText: "ALPHA", newText: "", source: "edit-input" },
  ]);
  expect(reportedArtifactFiles(s, null)).toEqual([]);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "one",
    rawInput: null,
  });
  expect(paneCards(s)).toHaveLength(1);
  present(s, {
    fields: { operation: "write", path: "target", newText: "replacement" },
  });
  expect(paneCards(s)).toMatchObject([
    { oldText: null, newText: "", source: "write-input", scope: "fragment" },
  ]);
});
