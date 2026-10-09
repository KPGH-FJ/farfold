import { describe, expect, it } from "vitest";
import { applyUpdate, freshThreadState } from "./session_projection";
import { hasAgentReply, hasToolResult } from "./round_result";

const fresh = () => freshThreadState("k", "fixture", "/work", "history");
const details = (value: unknown) =>
  (value as { reportedDetails?: unknown }).reportedDetails;

describe("reported extension fields stay with their existing entity", () => {
  it("keeps message and content fields without copying rendered text", () => {
    const state = fresh();
    applyUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      messageId: "first",
      content: { type: "text", text: "visible body", _meta: { citation: 2 } },
      _meta: { vendor: { parent: "declared-only" } },
      future: [1, null],
    });
    expect(details(state.items[0])).toEqual({
      "/update/_meta": { vendor: { parent: "declared-only" } },
      "/update/future": [1, null],
      "/update/content/_meta": { citation: 2 },
    });
    expect(JSON.stringify(details(state.items[0]))).not.toContain(
      "visible body",
    );
  });

  it("retains omitted fields and replaces opaque objects, arrays and explicit null", () => {
    const state = fresh();
    const chunk = (extra: object) => ({
      sessionUpdate: "agent_message_chunk",
      messageId: "first",
      content: { type: "text", text: "x" },
      ...extra,
    });
    applyUpdate(
      state,
      chunk({ _meta: { old: 1 }, future: [1, 2], retained: true }),
    );
    applyUpdate(state, chunk({ _meta: { next: 2 }, future: [3] }));
    applyUpdate(state, chunk({ _meta: null }));
    expect(state.items).toHaveLength(1);
    expect(details(state.items[0])).toEqual({
      "/update/_meta": null,
      "/update/future": [3],
      "/update/retained": true,
    });
  });

  it("does not mix distinct message IDs, roles or fresh recovery views", () => {
    const state = fresh();
    for (const [role, messageId, owner] of [
      ["agent", "a", "agent-a"],
      ["agent", "b", "agent-b"],
      ["thought", "b", "thought-b"],
    ])
      applyUpdate(state, {
        sessionUpdate: `agent_${role === "agent" ? "message" : role}_chunk`,
        messageId,
        content: { type: "text", text: owner },
        _meta: { owner },
      });
    expect(state.items.map(details)).toEqual([
      { "/update/_meta": { owner: "agent-a" } },
      { "/update/_meta": { owner: "agent-b" } },
      { "/update/_meta": { owner: "thought-b" } },
    ]);
    expect(details(fresh())).toBeUndefined();
  });

  it("keeps late tool details with its ID and avoids duplicating output or diff bodies", () => {
    const state = fresh();
    for (const toolCallId of ["old", "new"])
      applyUpdate(state, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: toolCallId,
        status: "pending",
        _meta: { owner: toolCallId },
      });
    applyUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "old",
      content: [
        {
          type: "diff",
          path: "/work/a",
          oldText: "old body",
          newText: "new body",
          extra: null,
        },
      ],
      locations: [{ path: "/work/a", line: 1, futureLine: [1, 4] }],
      rawOutput: { actual: "tool output" },
      later: "old-only",
    });
    const calls = state.items.flatMap((item) =>
      item.kind === "tool" ? [item.call] : [],
    );
    expect(details(calls[0])).toEqual({
      "/update/_meta": { owner: "old" },
      "/update/later": "old-only",
      "/update/content/0/extra": null,
      "/update/locations/0/futureLine": [1, 4],
    });
    expect(details(calls[1])).toEqual({ "/update/_meta": { owner: "new" } });
    expect(JSON.stringify(calls.map(details))).not.toContain("body");
  });

  it("preserves media metadata without another image or resource body", () => {
    const state = fresh();
    applyUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      messageId: "media",
      content: {
        type: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
        annotations: { audience: ["user"] },
      },
    });
    applyUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      messageId: "media",
      content: {
        type: "resource",
        resource: {
          uri: "file:///work/a",
          text: "resource body",
          _meta: { owner: 2 },
        },
      },
    });
    expect(details(state.items[0])).toEqual({
      "/update/content/annotations": { audience: ["user"] },
      "/update/content/resource/_meta": { owner: 2 },
    });
    expect(JSON.stringify(details(state.items[0]))).not.toMatch(
      /aW1hZ2U|resource body/,
    );
  });

  it("keeps non-message extensions outside reply and tool result accounting", () => {
    const state = fresh();
    applyUpdate(state, {
      sessionUpdate: "usage_update",
      used: 3,
      size: 100,
      _meta: { answer: "not a reply" },
    });
    applyUpdate(state, { sessionUpdate: "usage_update", used: 4, size: 100 });
    expect(details(state)).toEqual({
      "/usage_update/update/_meta": { answer: "not a reply" },
    });
    expect(state.items).toHaveLength(0);
    expect(hasAgentReply(state.items)).toBe(false);
    applyUpdate(state, {
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "pending",
      _meta: { status: "completed", rawOutput: "not a result" },
    });
    const item = state.items[0];
    expect(item?.kind === "tool" && hasToolResult(item.call)).toBe(false);
  });

  it("continues retaining a wholly unknown update without interpreting its payload", () => {
    const state = fresh();
    const update = {
      sessionUpdate: "future_update",
      content: { type: "text", text: "not a reply" },
      _meta: { success: true },
    };
    applyUpdate(state, update);
    expect(state.items).toMatchObject([{ kind: "raw", update }]);
    expect(hasAgentReply(state.items)).toBe(false);
  });

  it("does not carry indexed details into replaced options of a different type", () => {
    const state = fresh();
    applyUpdate(state, {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "same",
          name: "Choice",
          type: "select",
          currentValue: "a",
          options: [],
          _meta: { old: true },
        },
      ],
    });
    expect(details(state)).toHaveProperty(
      "/config_option_update/update/configOptions/0/_meta",
    );
    applyUpdate(state, {
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "same", name: "Choice", type: "boolean", currentValue: false },
      ],
    });
    expect(details(state)).toBeUndefined();
  });

  it("clears details of replaced tool content while preserving other omitted fields", () => {
    const state = fresh();
    applyUpdate(state, {
      sessionUpdate: "tool_call",
      toolCallId: "t",
      _meta: { retained: true },
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "old",
            _meta: { noLongerCurrent: true },
          },
        },
      ],
    });
    applyUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      content: [],
    });
    const item = state.items[0];
    expect(item?.kind === "tool" && details(item.call)).toEqual({
      "/update/_meta": { retained: true },
    });
  });
});
