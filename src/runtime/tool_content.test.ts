import { expect, it } from "vitest";
import { applyUpdate, freshThreadState } from "./session_projection";
import { hasReadableMessages } from "./message_attachments";
import { hasToolResult } from "./round_result";
import { reportedFiles } from "./file_delivery";

function tool(content: unknown[]) {
  const state = freshThreadState("tool-content", "fixture", "/work", "one");
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "output",
    kind: "execute",
    status: "in_progress",
    content,
  });
  const item = state.items[0]!;
  if (item.kind !== "tool") throw new Error("Expected tool output");
  return { state, call: item.call };
}

it.each([
  { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
  {
    type: "resource",
    resource: { uri: "file:///notes.md", text: "Returned notes" },
  },
  {
    type: "resource",
    resource: {
      uri: "memory:///report.pdf",
      blob: "cGRm",
      mimeType: "application/pdf",
    },
  },
])(
  "retains declared $type as tool content without admitting empty history or claiming a disk file",
  (content) => {
    const { state, call } = tool([{ type: "content", content }]);
    expect(call.content[0]?.type).toBe("attachment");
    expect(hasToolResult(call)).toBe(true);
    expect(hasReadableMessages(state.items)).toBe(false);
    expect(reportedFiles({ ...call, status: "completed" })).toEqual([]);
  },
);

it.each([
  { type: "text", text: { body: "Not declared text" } },
  { type: "image", data: "", mimeType: "image/png" },
  { type: "audio", mimeType: "audio/wav" },
  { type: "resource", resource: { uri: "file:///no-payload" } },
  { type: "resource", resource: ["not a resource"] },
  { type: "resource_link", name: "Missing target" },
  { type: "future", blob: "cGRm", mimeType: "application/pdf" },
])("keeps incomplete or unknown tool content raw: %j", (content) => {
  const { call } = tool([{ type: "content", content }]);
  expect(call.content).toEqual([{ type: "raw", value: content }]);
  expect(hasToolResult(call)).toBe(false);
});

it("keeps explicit resource links in the existing disk-verification candidate path", () => {
  const { call } = tool([
    {
      type: "content",
      content: {
        type: "resource_link",
        name: "Notes",
        uri: "file:///work/notes.md",
      },
    },
  ]);
  expect(reportedFiles({ ...call, status: "completed" })).toEqual([
    { path: "/work/notes.md", toolCallId: "output", source: "resourceLink" },
  ]);
});

it("only accepts a declared textual command input hint", () => {
  const state = freshThreadState("commands", "fixture", "/work", "one");
  applyUpdate(state, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      {
        name: "review",
        description: "Review",
        input: { hint: "Which files?" },
      },
      {
        name: "future",
        description: "Future",
        input: { hint: { text: "Unknown" } },
      },
    ],
  });
  expect(state.availableCommands[0]).toMatchObject({
    input: { hint: "Which files?" },
  });
  expect(state.availableCommands[1]?.input).toBeUndefined();
});
