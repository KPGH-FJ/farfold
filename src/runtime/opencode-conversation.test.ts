import { describe, expect, it } from "vitest";
import {
  hydrateOpenCodeTimeline,
  initialOpenCodeConversation,
  latestOpenCodeModel,
  reduceOpenCodeEvent,
  unwrapOpenCodeEvent,
  type OpenCodeConversationState,
} from "./opencode-conversation";
import { OPENCODE_RUNTIME_IDENTITY, type OpenCodeEnvelope } from "./opencode";

function envelope(payload: unknown): OpenCodeEnvelope {
  return {
    generation: 3,
    kind: "sse",
    payload: { directory: "/tmp/project", payload },
    runtime: OPENCODE_RUNTIME_IDENTITY,
  };
}

describe("OpenCode conversation projection", () => {
  it("restores the last model actually used by the native Session", () => {
    expect(
      latestOpenCodeModel([
        {
          info: {
            id: "msg_old",
            role: "assistant",
            providerID: "opencode",
            modelID: "big-pickle",
          },
          parts: [],
        },
        {
          info: { id: "msg_user", role: "user" },
          parts: [],
        },
        {
          info: {
            id: "msg_latest",
            role: "assistant",
            providerID: "zhipuai",
            modelID: "glm-5.3-flash",
          },
          parts: [],
        },
      ]),
    ).toEqual({ providerId: "zhipuai", modelId: "glm-5.3-flash" });
    expect(latestOpenCodeModel([{ info: { role: "user" }, parts: [] }])).toBe(
      null,
    );
  });

  it("hydrates official history while preserving native message and tool IDs", () => {
    const timeline = hydrateOpenCodeTimeline([
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [
          {
            id: "prt_user",
            messageID: "msg_user",
            type: "text",
            text: "检查项目",
          },
        ],
      },
      {
        info: {
          id: "msg_agent",
          sessionID: "ses_1",
          role: "assistant",
          finish: "stop",
        },
        parts: [
          {
            id: "prt_tool",
            callID: "call_1",
            messageID: "msg_agent",
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "README.md" },
              output: "done",
            },
          },
          {
            id: "prt_text",
            messageID: "msg_agent",
            type: "text",
            text: "检查完成。",
          },
        ],
      },
    ]);

    expect(timeline).toEqual([
      expect.objectContaining({
        kind: "message",
        id: "msg_user",
        role: "user",
        text: "检查项目",
      }),
      expect.objectContaining({
        kind: "message",
        id: "msg_agent",
        role: "assistant",
        text: "检查完成。",
      }),
      expect.objectContaining({
        kind: "tool",
        id: "prt_tool",
        name: "read",
        state: "completed",
      }),
    ]);
  });

  it("projects text deltas and native busy/idle state for only the bound Session", () => {
    let state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      envelope({
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "busy" } },
      }),
      "ses_1",
    );
    state = reduceOpenCodeEvent(
      state,
      envelope({
        type: "message.part.delta",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_agent",
          partID: "prt_text",
          field: "text",
          delta: "Hello",
        },
      }),
      "ses_1",
    );
    state = reduceOpenCodeEvent(
      state,
      envelope({
        type: "session.idle",
        properties: { sessionID: "ses_other" },
      }),
      "ses_1",
    );

    expect(state.isWorking).toBe(true);
    expect(state.timeline).toEqual([
      expect.objectContaining({ id: "msg_agent", text: "Hello" }),
    ]);

    state = reduceOpenCodeEvent(
      state,
      envelope({
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      }),
      "ses_1",
    );
    expect(state.isWorking).toBe(false);
  });

  it("promotes the optimistic user row to the native message ID without duplication", () => {
    let state: OpenCodeConversationState = {
      ...initialOpenCodeConversation,
      timeline: [
        {
          kind: "message" as const,
          id: "local-1",
          role: "user" as const,
          text: "Hello",
        },
      ],
    };
    state = reduceOpenCodeEvent(
      state,
      envelope({
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        },
      }),
      "ses_1",
    );
    state = reduceOpenCodeEvent(
      state,
      envelope({
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: {
            id: "prt_user",
            messageID: "msg_user",
            type: "text",
            text: "Hello",
          },
        },
      }),
      "ses_1",
    );

    expect(state.timeline).toEqual([
      expect.objectContaining({ id: "msg_user", role: "user", text: "Hello" }),
    ]);
  });

  it("treats observed native coordination markers as passive", () => {
    for (const type of ["sync", "server.heartbeat", "models-dev.refreshed"]) {
      const state = reduceOpenCodeEvent(
        initialOpenCodeConversation,
        envelope({ type, properties: {} }),
        "ses_1",
      );
      expect(state.unknownEventCount).toBe(0);
      expect(state.notice).toBeNull();
    }
  });

  it("keeps permission choices native and removes answered requests", () => {
    let state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      envelope({
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["git status"],
          always: ["git status"],
          metadata: { command: "git status" },
        },
      }),
      "ses_1",
    );
    expect(state.permissions[0]).toMatchObject({
      id: "per_1",
      permission: "bash",
      patterns: ["git status"],
    });

    state = reduceOpenCodeEvent(
      state,
      envelope({
        type: "permission.replied",
        properties: {
          sessionID: "ses_1",
          requestID: "per_1",
          reply: "once",
        },
      }),
      "ses_1",
    );
    expect(state.permissions).toEqual([]);
  });

  it("does not drop unknown raw events or infer their meaning", () => {
    const raw = {
      directory: "/tmp/project",
      payload: { type: "future.event", properties: { opaque: 7 } },
    };
    expect(unwrapOpenCodeEvent(raw)).toMatchObject({
      type: "future.event",
      raw,
    });
    const state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      {
        generation: 3,
        kind: "sse",
        payload: raw,
        runtime: OPENCODE_RUNTIME_IDENTITY,
      },
      "ses_1",
    );
    expect(state.unknownEventCount).toBe(1);
    expect(state.notice).toContain("future.event");
  });
});
