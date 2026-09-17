import { describe, expect, it } from "vitest";
import {
  hydrateOpenCodeTimeline,
  initialOpenCodeConversation,
  isOpenCodeIdleEvent,
  openCodeIdleNotice,
  latestOpenCodeModel,
  reduceOpenCodeEvent,
  settleOpenCodeConversation,
  unwrapOpenCodeEvent,
  verifyOpenCodeProviderRequest,
  type OpenCodeConversationState,
} from "./opencode-conversation";
import type { OpenCodeEnvelope } from "./opencode";

const OPENCODE_RUNTIME_IDENTITY = {
  productId: "opencode",
  installationId: "system-opencode-acp-test",
  adapterId: "opencode-acp-stdio-v1",
} as const;

function envelope(payload: unknown): OpenCodeEnvelope {
  return {
    generation: 3,
    kind: "sse",
    payload: { directory: "/tmp/project", payload },
    runtime: OPENCODE_RUNTIME_IDENTITY,
  };
}

function acpEnvelope(payload: unknown): OpenCodeEnvelope {
  return {
    generation: 3,
    kind: "acp",
    payload,
    runtime: {
      productId: "opencode",
      installationId: "system-opencode-acp-test",
      adapterId: "opencode-acp-stdio-v1",
    },
  };
}

describe("OpenCode conversation projection", () => {
  it("preserves unavailable native question notice after history settles", () => {
    const recovery = acpEnvelope({
      method: "_farfold/session_recovery",
      params: {
        sessionId: "ses_keep",
        reason: "native_question_no_longer_pending",
        unavailableQuestions: [{ nativePartId: "prt_old" }],
      },
    });
    const state = reduceOpenCodeEvent(
      {
        ...initialOpenCodeConversation,
        timeline: [
          {
            kind: "tool",
            id: "prt_old",
            name: "question",
            summary: "Old question",
            state: "running",
          },
        ],
      },
      recovery,
      "ses_keep",
      { questionBridge: true },
    );
    expect(state.notice).toContain("旧选项无法继续提交");
    expect(state.timeline[0]).toMatchObject({ state: "interrupted" });
    expect(settleOpenCodeConversation(state).notice).toBe(state.notice);
    expect(
      reduceOpenCodeEvent(initialOpenCodeConversation, recovery, "ses_other", {
        questionBridge: true,
      }),
    ).toEqual(initialOpenCodeConversation);
    expect(
      reduceOpenCodeEvent(initialOpenCodeConversation, recovery, "ses_keep")
        .unknownEventCount,
    ).toBe(1);
  });

  it("replaces optimistic user text with native ACP chunks without repeating the prompt", () => {
    let state: OpenCodeConversationState = {
      ...initialOpenCodeConversation,
      timeline: [
        { kind: "message", id: "local-1", role: "user", text: "Hello world" },
      ],
    };
    for (const text of ["Hello", " world"]) {
      state = reduceOpenCodeEvent(
        state,
        acpEnvelope({
          method: "session/update",
          params: {
            sessionId: "ses_keep",
            update: {
              sessionUpdate: "user_message_chunk",
              messageId: "msg_native",
              content: { type: "text", text },
            },
          },
        }),
        "ses_keep",
      );
    }
    expect(state.timeline).toEqual([
      expect.objectContaining({ id: "msg_native", text: "Hello world" }),
    ]);
  });

  it("projects ACP chunks, tools, plans, and permission options during a prompt", () => {
    let state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "msg_acp",
            content: { type: "text", text: "hello" },
          },
        },
      }),
      "ses_keep",
    );
    expect(state.timeline).toContainEqual(
      expect.objectContaining({
        id: "msg_acp",
        role: "assistant",
        text: "hello",
      }),
    );
    expect(state.isWorking).toBe(true);

    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            title: "Read file",
            kind: "read",
            status: "pending",
          },
        },
      }),
      "ses_keep",
    );
    expect(state.timeline).toContainEqual(
      expect.objectContaining({ id: "call_1", name: "Read file" }),
    );

    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/request_permission",
        id: 0,
        params: {
          sessionId: "ses_keep",
          toolCall: { toolCallId: "call_1", title: "Read file" },
          options: [
            {
              optionId: "allow-once",
              name: "Allow once",
              kind: "allow_once",
            },
          ],
        },
      }),
      "ses_keep",
    );
    expect(state.permissions).toEqual([
      expect.objectContaining({
        id: "0",
        adapter: "acp",
        options: [
          {
            optionId: "allow-once",
            name: "Allow once",
            kind: "allow_once",
          },
        ],
      }),
    ]);

    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Inspect",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        },
      }),
      "ses_keep",
    );
    expect(state.timeline).toContainEqual(
      expect.objectContaining({
        id: "acp-plan",
        summary: "in_progress: Inspect",
      }),
    );
    expect(state.unknownEventCount).toBe(0);
  });

  it("projects ACP form elicitation as a native OpenCode question", () => {
    const state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "elicitation/create",
        id: "elicitation-1",
        params: {
          sessionId: "ses_keep",
          mode: "form",
          message: "Choose the route",
          requestedSchema: {
            type: "object",
            properties: {
              choice: {
                type: "string",
                enum: ["ACP bridge", "Stop"],
              },
            },
            required: ["choice"],
          },
        },
      }),
      "ses_keep",
      { questionBridge: true },
    );

    expect(state.permissions).toEqual([
      expect.objectContaining({
        id: "elicitation-1",
        sessionId: "ses_keep",
        requestKind: "question",
        permission: "Choose the route",
        adapter: "acp",
        options: [
          { optionId: "ACP bridge", name: "ACP bridge", kind: "accept" },
          { optionId: "Stop", name: "Stop", kind: "accept" },
        ],
      }),
    ]);
    expect(state.isWorking).toBe(true);
  });

  it("does not project ACP form elicitation without the OpenCode question bridge capability", () => {
    const state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "elicitation/create",
        id: "elicitation-1",
        params: {
          sessionId: "ses_keep",
          mode: "form",
          message: "Choose the route",
          requestedSchema: {
            type: "object",
            properties: {
              choice: {
                type: "string",
                enum: ["ACP bridge", "Stop"],
              },
            },
            required: ["choice"],
          },
        },
      }),
      "ses_keep",
    );

    expect(state.permissions).toEqual([]);
    expect(state.unknownEventCount).toBe(1);
    expect(state.notice).toContain("未声明原生提问桥接");
  });

  it("preserves all native question fields, descriptions, multiple selection and custom entry", () => {
    const state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      acpEnvelope({
        method: "elicitation/create",
        id: "multi",
        params: {
          sessionId: "ses_keep",
          mode: "form",
          message: "First",
          requestedSchema: {
            type: "object",
            properties: {
              choice: {
                type: "string",
                title: "First",
                enum: ["A"],
                _meta: {
                  farfoldCustomField: "choice_other",
                  farfoldQuestionOptions: [
                    { label: "A", description: "Alpha" },
                  ],
                },
              },
              choice_other: {
                type: "string",
                _meta: { farfoldCustomFor: "choice" },
              },
              choice1: {
                type: "array",
                title: "Second",
                items: { type: "string", enum: ["B", "C"] },
              },
            },
          },
        },
      }),
      "ses_keep",
      { questionBridge: true },
    );
    expect(state.permissions[0].questionFields).toEqual([
      {
        id: "choice",
        title: "First",
        multiple: false,
        customField: "choice_other",
        options: [{ label: "A", description: "Alpha" }],
      },
      {
        id: "choice1",
        title: "Second",
        multiple: true,
        customField: null,
        options: [
          { label: "B", description: "" },
          { label: "C", description: "" },
        ],
      },
    ]);
  });

  it("keeps separate ACP replies when native chunks omit message IDs", () => {
    let state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "first" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " reply" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      envelope({ type: "session.idle", properties: { sessionID: "ses_keep" } }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "second reply" },
          },
        },
      }),
      "ses_keep",
    );
    expect(state.timeline).toEqual([
      expect.objectContaining({
        id: "acp-agent-message-1",
        role: "assistant",
        text: "first reply",
        pending: false,
      }),
      expect.objectContaining({
        id: "acp-agent-message-2",
        role: "assistant",
        text: "second reply",
        pending: true,
      }),
    ]);
  });

  it("projects ACP session/load replayed user and agent message chunks", () => {
    let state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: "msg_user",
            content: { type: "text", text: "cold replay seed" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "msg_agent",
            content: { type: "text", text: "ok" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [],
          },
        },
      }),
      "ses_keep",
    );
    state = settleOpenCodeConversation(state);

    expect(state.timeline).toEqual([
      expect.objectContaining({
        id: "msg_user",
        role: "user",
        text: "cold replay seed",
        pending: false,
      }),
      expect.objectContaining({
        id: "msg_agent",
        role: "assistant",
        text: "ok",
      }),
    ]);
    expect(state.isWorking).toBe(false);
    expect(state.unknownEventCount).toBe(0);
  });

  it("keeps multi-turn ACP replay separate when native chunks omit message IDs", () => {
    let state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "U" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "1" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "A1" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "U2" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "A2" },
          },
        },
      }),
      "ses_keep",
    );

    expect(state.timeline).toEqual([
      expect.objectContaining({
        id: "acp-user-message-1",
        role: "user",
        text: "U1",
        pending: false,
      }),
      expect.objectContaining({
        id: "acp-agent-message-1",
        role: "assistant",
        text: "A1",
        pending: false,
      }),
      expect.objectContaining({
        id: "acp-user-message-2",
        role: "user",
        text: "U2",
        pending: false,
      }),
      expect.objectContaining({
        id: "acp-agent-message-2",
        role: "assistant",
        text: "A2",
        pending: true,
      }),
    ]);

    state = settleOpenCodeConversation(state);
    expect(state.timeline).toEqual([
      expect.objectContaining({ text: "U1", pending: false }),
      expect.objectContaining({ text: "A1", pending: false }),
      expect.objectContaining({ text: "U2", pending: false }),
      expect.objectContaining({ text: "A2", pending: false }),
    ]);
    expect(state.isWorking).toBe(false);
  });

  it("does not treat ACP command list updates as prompt completion", () => {
    let state = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "still running" },
          },
        },
      }),
      "ses_keep",
    );
    state = reduceOpenCodeEvent(
      state,
      acpEnvelope({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_keep",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [],
          },
        },
      }),
      "ses_keep",
    );

    expect(state.isWorking).toBe(true);
    expect(state.timeline).toContainEqual(
      expect.objectContaining({ text: "still running", pending: true }),
    );
    expect(state.unknownEventCount).toBe(0);

    state = settleOpenCodeConversation(state);
    expect(state.isWorking).toBe(false);
    expect(state.timeline).toContainEqual(
      expect.objectContaining({ text: "still running", pending: false }),
    );
  });

  it("keeps ACP transport failures result-unknown until an operation settles", () => {
    const state = reduceOpenCodeEvent(
      { ...initialOpenCodeConversation, isWorking: true },
      {
        generation: 3,
        kind: "transport_error",
        payload: { error: "connection closed" },
        runtime: {
          productId: "opencode",
          installationId: "system-opencode-acp-test",
          adapterId: "opencode-acp-stdio-v1",
        },
      },
      "ses_keep",
    );

    expect(state.outcomeUnknown).toBe(true);
    expect(state.notice).toContain("尚未确认");
  });

  it("removes resolved uncertainty text while preserving a native error after verified idle", () => {
    const uncertain = reduceOpenCodeEvent(
      { ...initialOpenCodeConversation, isWorking: true },
      envelope({ type: "session.idle", properties: { sessionID: "ses_1" } }),
      "ses_1",
    );
    expect(uncertain.outcomeUnknown).toBe(true);
    expect(uncertain.notice).toContain("仍未确认");
    expect(openCodeIdleNotice(uncertain)).toBeNull();
    expect(
      openCodeIdleNotice({ ...uncertain, notice: "OpenCode：Aborted" }),
    ).toBe("OpenCode：Aborted");
  });

  it("requests terminal reconciliation only for exact native idle events", () => {
    for (const type of ["session.idle", "session.status"]) {
      const event = envelope({
        type,
        properties: { sessionID: "ses_1", status: { type: "idle" } },
      });
      expect(isOpenCodeIdleEvent(event.payload, "ses_1")).toBe(true);
      expect(isOpenCodeIdleEvent(event.payload, "ses_other")).toBe(false);
    }
    for (const status of [null, "idle", {}, { type: "busy" }]) {
      expect(
        isOpenCodeIdleEvent(
          {
            type: "session.status",
            properties: { sessionID: "ses_1", status },
          },
          "ses_1",
        ),
      ).toBe(false);
    }
    expect(
      isOpenCodeIdleEvent(
        { type: "session.error", properties: { sessionID: "ses_1" } },
        "ses_1",
      ),
    ).toBe(false);
  });

  it("expires pending native permissions when an observed Session becomes idle", () => {
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
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_1",
          permission: "external_directory",
          patterns: ["/qa/**"],
          metadata: {},
        },
      }),
      "ses_1",
    );
    expect(state.permissions).toHaveLength(1);
    const other = reduceOpenCodeEvent(
      state,
      envelope({
        type: "session.idle",
        properties: { sessionID: "ses_other" },
      }),
      "ses_1",
    );
    expect(other.permissions).toHaveLength(1);
    const idle = reduceOpenCodeEvent(
      other,
      envelope({ type: "session.idle", properties: { sessionID: "ses_1" } }),
      "ses_1",
    );
    expect(idle.permissions).toHaveLength(0);
    expect(idle.isWorking).toBe(false);
  });

  it("shows native errors without treating them as a task terminal", () => {
    const error = envelope({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { message: "Read failed" } },
    });
    const pending = reduceOpenCodeEvent(
      { ...initialOpenCodeConversation, isWorking: true },
      error,
      "ses_1",
    );
    expect(pending.isWorking).toBe(true);
    expect(pending.runtimeObserved).toBe(false);
    expect(pending.notice).toContain("Read failed");
    const busy = reduceOpenCodeEvent(
      pending,
      envelope({
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "busy" } },
      }),
      "ses_1",
    );
    const interrupted = { ...busy, outcomeUnknown: true };
    const diagnostic = reduceOpenCodeEvent(interrupted, error, "ses_1");
    expect(diagnostic.isWorking).toBe(true);
    expect(diagnostic.outcomeUnknown).toBe(true);
    const idle = reduceOpenCodeEvent(
      diagnostic,
      envelope({ type: "session.idle", properties: { sessionID: "ses_1" } }),
      "ses_1",
    );
    expect(idle.isWorking).toBe(false);
    expect(idle.outcomeUnknown).toBe(false);
    expect(idle.notice).toContain("Read failed");
  });

  it("keeps an interrupted active task occupied until a native terminal event", () => {
    const busy = reduceOpenCodeEvent(
      initialOpenCodeConversation,
      envelope({
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "busy" } },
      }),
      "ses_1",
    );
    const interrupted = reduceOpenCodeEvent(
      busy,
      { ...envelope({ error: "socket closed" }), kind: "transport_error" },
      "ses_1",
    );
    expect(interrupted.isWorking).toBe(true);
    expect(interrupted.outcomeUnknown).toBe(true);
    const idle = reduceOpenCodeEvent(
      interrupted,
      envelope({ type: "session.idle", properties: { sessionID: "ses_1" } }),
      "ses_1",
    );
    expect(idle.isWorking).toBe(false);
    expect(idle.outcomeUnknown).toBe(false);
  });

  it("keeps ACP native events as read-only fallback without treating them as SSE loss", () => {
    const busy = {
      ...initialOpenCodeConversation,
      isWorking: true,
      runtimeObserved: true,
    };
    const state = reduceOpenCodeEvent(
      busy,
      {
        generation: 3,
        kind: "acp",
        payload: { method: "session/update", params: { opaque: 7 } },
        runtime: OPENCODE_RUNTIME_IDENTITY,
      },
      "ses_1",
    );
    expect(state.isWorking).toBe(true);
    expect(state.outcomeUnknown).toBe(false);
    expect(state.unknownEventCount).toBe(1);
    expect(state.notice).toContain("ACP");
    expect(state.notice).not.toContain("连接中断");
  });

  it("does not turn idle before any observed run into proof of submission failure", () => {
    const pending = { ...initialOpenCodeConversation, isWorking: true };
    const idle = reduceOpenCodeEvent(
      pending,
      envelope({ type: "session.idle", properties: { sessionID: "ses_1" } }),
      "ses_1",
    );
    expect(idle.isWorking).toBe(true);
    expect(idle.outcomeUnknown).toBe(true);
  });

  it.each(["session.idle", "session.status"])(
    "ends the retry notice only on matching native idle (%s)",
    (type) => {
      const retry = reduceOpenCodeEvent(
        initialOpenCodeConversation,
        envelope({
          type: "session.status",
          properties: {
            sessionID: "ses_1",
            status: { type: "retry", message: "Insufficient balance" },
          },
        }),
        "ses_1",
      );
      const foreign = reduceOpenCodeEvent(
        retry,
        envelope({
          type,
          properties: { sessionID: "ses_other", status: { type: "idle" } },
        }),
        "ses_1",
      );
      expect(foreign.isWorking).toBe(true);
      expect(foreign.notice).toContain("正在重试");
      const idle = reduceOpenCodeEvent(
        foreign,
        envelope({
          type,
          properties: { sessionID: "ses_1", status: { type: "idle" } },
        }),
        "ses_1",
      );
      expect(idle.isWorking).toBe(false);
      expect(idle.notice).not.toContain("正在重试");
      expect(idle.notice).toContain("Insufficient balance");
      expect(idle.notice).not.toContain("成功");
    },
  );

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

  it("verifies Provider requests only from new successful assistant messages", () => {
    const oldAssistant = {
      info: {
        id: "msg_old",
        role: "assistant",
        providerID: "zhipuai",
        modelID: "glm-5.3-flash",
        finish: "stop",
      },
      parts: [],
    };
    expect(
      verifyOpenCodeProviderRequest([oldAssistant], {
        providerId: "zhipuai",
        modelId: "glm-5.3-flash",
        baselineMessageCount: 1,
      }),
    ).toMatchObject({
      matched: false,
      detail: expect.stringContaining("new assistant"),
    });
    expect(
      verifyOpenCodeProviderRequest(
        [
          oldAssistant,
          {
            info: { id: "msg_user", role: "user" },
            parts: [],
          },
          {
            info: {
              id: "msg_new",
              role: "assistant",
              providerID: "zhipuai",
              modelID: "glm-5.3-flash",
              finish: "stop",
            },
            parts: [],
          },
        ],
        {
          providerId: "zhipuai",
          modelId: "glm-5.3-flash",
          baselineMessageCount: 1,
        },
      ),
    ).toMatchObject({ matched: true });
  });

  it("does not verify Provider requests from native errors, cancellation, or model mismatch", () => {
    for (const info of [
      {
        role: "assistant",
        providerID: "zhipuai",
        modelID: "glm-5.3-flash",
        finish: "stop",
        error: { message: "insufficient balance" },
      },
      {
        role: "assistant",
        providerID: "zhipuai",
        modelID: "glm-5.3-flash",
        finish: "abort",
      },
      {
        role: "assistant",
        providerID: "other",
        modelID: "other-model",
        finish: "stop",
      },
    ]) {
      expect(
        verifyOpenCodeProviderRequest(
          [
            { info: { id: "msg_old", role: "assistant" }, parts: [] },
            { info, parts: [] },
          ],
          {
            providerId: "zhipuai",
            modelId: "glm-5.3-flash",
            baselineMessageCount: 1,
          },
        ).matched,
      ).toBe(false);
    }
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
