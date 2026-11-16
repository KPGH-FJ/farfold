import { expect, it } from "vitest";
import {
  applyUpdate,
  freshThreadState,
  sealStreams,
} from "./session_projection";
import { sessionOperations } from "./session_fork_types";
import {
  hasHistoryForkPoint,
  historyForkableItems,
  historyForkSelection,
} from "./history_fork_point";

function fixture() {
  const thread = freshThreadState("a:/work:parent", "a", "/work", "parent");
  thread.connectionId = "connection";
  return thread;
}
function event(messageId: string, text = "Message") {
  return {
    sessionId: "parent",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
    presentation: {
      kind: "historyForkPoint",
      connectionId: "connection",
      messageId,
    },
  };
}
it("projects reviewed message anchors without modifying their original envelope", () => {
  const thread = fixture();
  const first = event("official-1", "Earlier");
  const saved = structuredClone(first);
  applyUpdate(thread, first.update, first);
  const second = event("official-2", "Later");
  applyUpdate(thread, second.update, second);
  sealStreams(thread);
  expect(thread.items).toMatchObject([
    {
      kind: "agent",
      messageId: "official-1",
      text: "Earlier",
      historyForkPoint: { messageId: "official-1", connectionId: "connection" },
    },
    {
      kind: "agent",
      messageId: "official-2",
      text: "Later",
      historyForkPoint: { messageId: "official-2", connectionId: "connection" },
    },
  ]);
  expect(first).toEqual(saved);
});
it("exposes historical capability only from its explicit declaration", () => {
  expect(sessionOperations({ forkCurrentContext: true })).toMatchObject({
    forkHistoricalPoint: false,
  });
  expect(sessionOperations({ forkHistoricalPoint: true })).toMatchObject({
    forkHistoricalPoint: true,
  });
});
it.each(["owner", "session", "identity", "unknown", "lost"])(
  "does not grant a point from %s metadata",
  (kind) => {
    const thread = fixture();
    const value: any = event("official");
    if (kind === "owner") value.presentation.connectionId = "another";
    if (kind === "session") value.sessionId = "another";
    if (kind === "identity") value.update.messageId = "different";
    if (kind === "unknown") value.presentation.future = true;
    if (kind === "lost") thread.connectionLost = true;
    applyUpdate(thread, value.update, value);
    expect(thread.items.every((item) => !("historyForkPoint" in item))).toBe(
      true,
    );
  },
);

it("uses the same ownership and duplicate checks for displayed and confirmed fork targets", () => {
  const thread = fixture();
  thread.sessionOperations = sessionOperations({ forkHistoricalPoint: true });
  for (const messageId of ["duplicate", "valid", "replaced"]) {
    const original = event(messageId);
    applyUpdate(thread, original.update, original);
  }
  sealStreams(thread);
  const [duplicate, valid, replaced] = thread.items;
  if (duplicate.kind !== "agent" || replaced.kind !== "agent")
    throw new Error("Expected fixture messages");
  replaced.historyForkPoint = { messageId: "replaced", connectionId: "old" };
  thread.items.push({ ...duplicate, id: "later", historyForkPoint: undefined });

  expect([...historyForkableItems(thread)]).toEqual([valid]);
  expect(hasHistoryForkPoint(thread, { messageId: "duplicate" })).toBe(false);
  expect(hasHistoryForkPoint(thread, { messageId: "valid" })).toBe(true);
  expect(historyForkSelection(thread, { ...valid })).toBeUndefined();
  thread.items.push(valid);
  expect(historyForkableItems(thread).size).toBe(0);
  expect(historyForkSelection(thread, valid)).toBeUndefined();
  thread.items.pop();
  thread.connectionLost = true;
  expect(historyForkableItems(thread).size).toBe(0);
  expect(hasHistoryForkPoint(thread, { messageId: "valid" })).toBe(false);
});
