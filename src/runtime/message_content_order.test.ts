import { expect, it } from "vitest";
import { applyUpdate, freshThreadState } from "./session_projection";
import { checkedMessageContentOrder } from "./message_content_order";

const resource = {
  type: "resource",
  resource: {
    uri: "file:///owned/order.txt",
    mimeType: "text/plain",
    text: "Original attachment body",
  },
};

function chunks(contents: unknown[], messageId = "message") {
  const state = freshThreadState("order", "chosen", "/owned", "id");
  for (const content of contents)
    applyUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content,
    });
  return state;
}

it("coalesces continuous text chunks as one Markdown run, preserving UTF-16 offsets", () => {
  const state = chunks([
    { type: "text", text: "**be" },
    { type: "text", text: "fore🙂**" },
    resource,
    { type: "text", text: "After" },
    { type: "text", text: "" },
  ]);
  expect(state.items).toHaveLength(1);
  expect(state.items[0]).toMatchObject({
    text: "**before🙂**After",
    contentOrder: [
      { kind: "text", start: 0, end: 12 },
      { kind: "attachments", start: 0, end: 1 },
      { kind: "text", start: 12, end: 17 },
    ],
    attachments: [
      { text: "Original attachment body", uri: resource.resource.uri },
    ],
  });
});

it("groups consecutive attachments without merging across intervening text", () => {
  const state = chunks([
    resource,
    resource,
    { type: "text", text: "Caption" },
    resource,
  ]);
  expect(state.items[0]).toMatchObject({
    text: "Caption",
    contentOrder: [
      { kind: "attachments", start: 0, end: 2 },
      { kind: "text", start: 0, end: 7 },
      { kind: "attachments", start: 2, end: 3 },
    ],
  });
});

it("initializes independent order at an explicit official message boundary", () => {
  const state = chunks([resource]);
  applyUpdate(state, {
    sessionUpdate: "agent_message_chunk",
    messageId: "different-message",
    content: { type: "text", text: "Separate" },
    contentOrder: [{ kind: "attachments", start: 99, end: 100 }],
  });
  expect(state.items).toHaveLength(2);
  expect(state.items[1]).toMatchObject({
    messageId: "different-message",
    contentOrder: [{ kind: "text", start: 0, end: 8 }],
  });
});

it("does not guess the missing order of an already-loaded legacy message", () => {
  const state = chunks([{ type: "text", text: "Legacy" }]);
  const item = state.items[0];
  if (item.kind !== "agent") throw Error("Expected an Agent item");
  delete item.contentOrder;
  applyUpdate(state, {
    sessionUpdate: "agent_message_chunk",
    messageId: "message",
    content: resource,
  });
  applyUpdate(state, {
    sessionUpdate: "agent_message_chunk",
    messageId: "message",
    content: { type: "text", text: " added" },
  });
  expect(item.text).toBe("Legacy added");
  expect(item.attachments).toHaveLength(1);
  expect(item.contentOrder).toBeUndefined();
});

it("uses the same order projection for replay while retaining attachment and aggregate text", () => {
  const contents = [resource, { type: "text", text: "Replay caption" }];
  const state = chunks(contents);
  for (const item of state.items) if ("time" in item) item.time = 0;
  const item = state.items[0];
  if (item.kind !== "agent") throw Error("Expected an Agent item");
  expect(
    checkedMessageContentOrder(item.text.length, 1, item.contentOrder),
  ).toEqual([
    { kind: "attachments", start: 0, end: 1 },
    { kind: "text", start: 0, end: 14 },
  ]);
  expect(item.attachments?.[0].text).toBe(resource.resource.text);
  expect(item.time).toBe(0);
});

it.each([
  undefined,
  [],
  [{ kind: "text" as const, start: 1, end: 4 }],
  [{ kind: "text" as const, start: 0, end: 5 }],
  [
    { kind: "text" as const, start: 0, end: 4 },
    { kind: "attachments" as const, start: 0, end: 1 },
    { kind: "attachments" as const, start: 0, end: 1 },
  ],
])(
  "leaves the full legacy view available for incomplete or duplicate ranges: %j",
  (order) => {
    expect(checkedMessageContentOrder(4, 1, order)).toBeNull();
  },
);
