import { describe, expect, it } from "vitest";
import {
  applyUpdate,
  freshThreadState,
  sealStreams,
} from "./session_projection";

const textChunk = (
  role: "user" | "agent",
  id: string | undefined,
  text: string,
) => ({
  sessionUpdate: `${role}_message_chunk`,
  ...(id === undefined ? {} : { messageId: id }),
  content: { type: "text", text },
});

describe("official replay message boundaries", () => {
  it.each(["user", "agent"] as const)(
    "keeps distinct adjacent %s message IDs separate while joining chunks of one message",
    (role) => {
      const state = freshThreadState("k", "fixture", "/work", "history");
      for (const event of [
        textChunk(role, "message-1", "First "),
        textChunk(role, "message-1", "message"),
        textChunk(role, "message-2", "Second message"),
      ])
        applyUpdate(state, event);
      expect(state.items).toHaveLength(2);
      expect(state.items[0]).toMatchObject({
        kind: role,
        text: "First message",
      });
      expect(state.items[1]).toMatchObject({
        kind: role,
        text: "Second message",
      });
    },
  );

  it("does not discard an identical user message with a different official ID as an optimistic echo", () => {
    const state = freshThreadState("k", "fixture", "/work", "history");
    applyUpdate(state, textChunk("user", "earlier", "Please continue"));
    sealStreams(state);
    applyUpdate(state, textChunk("user", "later", "Please continue"));
    expect(state.items).toHaveLength(2);
    expect(state.items.map((item) => "text" in item && item.text)).toEqual([
      "Please continue",
      "Please continue",
    ]);
  });

  it.each(["user", "agent"] as const)(
    "keeps %s attachments on their declared message instead of the previous message",
    (role) => {
      const state = freshThreadState("k", "fixture", "/work", "history");
      const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
      applyUpdate(state, textChunk(role, "first", "First caption"));
      applyUpdate(state, {
        sessionUpdate: `${role}_message_chunk`,
        messageId: "second",
        content: image,
      });
      applyUpdate(state, textChunk(role, "second", "Second caption"));
      expect(state.items).toHaveLength(2);
      expect(state.items[0]).toMatchObject({
        kind: role,
        text: "First caption",
      });
      expect(state.items[0]).not.toHaveProperty("attachments.0");
      expect(state.items[1]).toMatchObject({
        kind: role,
        text: "Second caption",
        attachments: [{ kind: "image", data: "aW1hZ2U=" }],
      });
    },
  );

  it("retains the legacy chunk fallback when the Agent supplies no message IDs", () => {
    const state = freshThreadState("k", "fixture", "/work", "history");
    applyUpdate(state, textChunk("agent", undefined, "First "));
    applyUpdate(state, textChunk("agent", undefined, "second"));
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "agent",
      text: "First second",
    });
  });

  it("uses the declared identity when thought messages are consecutive", () => {
    const state = freshThreadState("k", "fixture", "/work", "history");
    for (const [messageId, text] of [
      ["one", "First"],
      ["two", "Second"],
    ])
      applyUpdate(state, {
        sessionUpdate: "agent_thought_chunk",
        messageId,
        content: { type: "text", text },
      });
    expect(state.items).toMatchObject([
      { kind: "thought", messageId: "one", text: "First" },
      { kind: "thought", messageId: "two", text: "Second" },
    ]);
  });

  it("assigns an ID to current optimistic text echoes without duplicating chunked echoes", () => {
    const state = freshThreadState("k", "fixture", "/work", "history");
    state.running = true;
    state.items.push({
      kind: "user",
      id: "local",
      text: "Please continue",
      attachments: [],
      streaming: false,
      time: 1,
    });
    state.roundItemBase = state.items.length;
    applyUpdate(state, textChunk("user", "remote-echo", "Please "));
    applyUpdate(state, textChunk("user", "remote-echo", "continue"));
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      messageId: "remote-echo",
      text: "Please continue",
    });
    applyUpdate(state, textChunk("user", "later-message", "Please continue"));
    expect(state.items).toHaveLength(2);
  });

  it("does not duplicate a current optimistic attachment when its echo supplies an ID", () => {
    const state = freshThreadState("k", "fixture", "/work", "history");
    state.running = true;
    const content = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    applyUpdate(state, { sessionUpdate: "user_message_chunk", content });
    sealStreams(state);
    state.roundItemBase = state.items.length;
    applyUpdate(state, {
      sessionUpdate: "user_message_chunk",
      messageId: "echo",
      content,
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toHaveProperty("messageId", "echo");
    applyUpdate(state, {
      sessionUpdate: "user_message_chunk",
      messageId: "other",
      content,
    });
    expect(state.items).toHaveLength(2);
  });
});
