import { expect, it } from "vitest";
import { applyUpdate, freshThreadState } from "./session_projection";
import { reportedFiles } from "./file_delivery";

const invalidPaths = [
  123,
  true,
  { path: "untrusted.md" },
  ["untrusted.md"],
].map((path) => ({ path }));
it.each(invalidPaths)(
  "does not promote a non-string protocol location into a file target: $path",
  ({ path }) => {
    const s = freshThreadState("shape", "fixture", "/work", "one");
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "write",
      kind: "edit",
      status: "completed",
      locations: [{ path }],
    });
    const item = s.items[0];
    if (item.kind !== "tool") throw new Error("Expected tool");
    expect(reportedFiles(item.call)).toEqual([]);
    expect(item.call.locations).toEqual([]);
    expect(item.call.reportedDetails?.["/update/locations/0"]).toEqual({
      path,
    });
    applyUpdate(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "write",
      locations: [],
    });
    expect(item.call.reportedDetails?.["/update/locations/0"]).toBeUndefined();
  },
);

it.each(invalidPaths)(
  "retains a non-string diff target as raw content, never as a file: $path",
  ({ path }) => {
    const s = freshThreadState("shape", "fixture", "/work", "one");
    const content = { type: "diff", path, oldText: null, newText: "reported" };
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "write",
      kind: "edit",
      status: "completed",
      content: [content],
    });
    const item = s.items[0];
    if (item.kind !== "tool") throw new Error("Expected tool");
    expect(reportedFiles(item.call)).toEqual([]);
    expect(item.call.content).toEqual([{ type: "raw", value: content }]);
  },
);
