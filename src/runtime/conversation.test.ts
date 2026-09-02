import { describe, expect, it } from "vitest";
import {
  hydrateTimeline,
  initialConversation,
  projectUnknownPiEvent,
  reducePiEvent,
} from "./conversation";

describe("Pi conversation projection", () => {
  it("projects streamed assistant text and keeps the final Pi message authoritative", () => {
    const started = reducePiEvent(initialConversation, {
      type: "message_start",
      message: { id: "a1", role: "assistant", content: [] },
    });
    const streamed = reducePiEvent(started, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "你好" },
    });
    const finished = reducePiEvent(streamed, {
      type: "message_end",
      message: {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "你好，世界" }],
      },
    });

    expect(finished.timeline).toEqual([
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        text: "你好，世界",
        pending: false,
      },
    ]);
  });

  it("assembles thinking deltas separately from visible answer text", () => {
    const started = reducePiEvent(initialConversation, {
      type: "message_start",
      message: { id: "a1", role: "assistant", content: [] },
    });
    const thinking = reducePiEvent(started, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "check files" },
    });
    const answer = reducePiEvent(thinking, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Done" },
    });

    expect(answer.timeline[0]).toMatchObject({
      kind: "message",
      thinking: "check files",
      text: "Done",
    });
  });

  it("preserves Pi queue semantics and tool progress", () => {
    const queued = reducePiEvent(initialConversation, {
      type: "queue_update",
      steering: ["改为总结"],
      followUp: ["完成后列要点"],
    });
    const started = reducePiEvent(queued, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "notes.md" },
    });
    const ended = reducePiEvent(started, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: "read 12 lines" }] },
      isError: false,
    });

    expect(ended.steering).toEqual(["改为总结"]);
    expect(ended.followUp).toEqual(["完成后列要点"]);
    expect(ended.timeline[0]).toMatchObject({
      kind: "tool",
      state: "completed",
      summary: "read 12 lines",
    });
  });

  it("hydrates persisted messages and tool results in Pi order", () => {
    expect(
      hydrateTimeline([
        { id: "u1", role: "user", content: "read two files" },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "read",
          content: [{ type: "text", text: "12 lines" }],
          isError: false,
        },
        {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      ]),
    ).toEqual([
      {
        kind: "message",
        id: "u1",
        role: "user",
        text: "read two files",
      },
      {
        kind: "tool",
        id: "t1",
        name: "read",
        summary: "12 lines",
        state: "completed",
      },
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        text: "done",
      },
    ]);
  });

  it("does not render persisted assistant tool-call envelopes as empty messages", () => {
    expect(
      hydrateTimeline([
        {
          id: "tool-envelope",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "notes.md" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "12 lines" }],
        },
      ]),
    ).toEqual([
      {
        kind: "tool",
        id: "call-1",
        name: "read",
        summary: "12 lines",
        state: "completed",
      },
    ]);
  });

  it("removes the pending assistant row when a live turn ends as tool calls only", () => {
    const started = reducePiEvent(initialConversation, {
      type: "message_start",
      message: { id: "tool-envelope", role: "assistant", content: [] },
    });
    const finished = reducePiEvent(started, {
      type: "message_end",
      message: {
        id: "tool-envelope",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "notes.md" },
          },
        ],
      },
    });

    expect(finished.timeline).toEqual([]);
  });

  it("keeps Pi provider failures explicit in the transcript", () => {
    const next = reducePiEvent(initialConversation, {
      type: "message_end",
      message: {
        id: "a1",
        role: "assistant",
        content: [],
        errorMessage: "402: Insufficient Balance",
      },
    });

    expect(next.timeline).toEqual([
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        text: "Provider 余额不足（402 Insufficient Balance）。请充值或切换到可用 Provider 后重试。",
        error: true,
      },
    ]);
  });

  it("keeps tool activity between the assistant turns that produced it", () => {
    const first = reducePiEvent(initialConversation, {
      type: "message_end",
      message: {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "I will inspect it." }],
      },
    });
    const tool = reducePiEvent(first, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "one.md" },
    });
    const second = reducePiEvent(tool, {
      type: "message_end",
      message: {
        id: "a2",
        role: "assistant",
        content: [{ type: "text", text: "Inspection finished." }],
      },
    });

    expect(second.timeline.map((item) => item.kind)).toEqual([
      "message",
      "tool",
      "message",
    ]);
  });

  it("surfaces Pi-native compaction and retry state", () => {
    const compacting = reducePiEvent(initialConversation, {
      type: "compaction_start",
      reason: "threshold",
    });
    const retrying = reducePiEvent(compacting, {
      type: "auto_retry_start",
      attempt: 2,
    });

    expect(compacting.notice).toContain("压缩上下文");
    expect(retrying.notice).toContain("第 2 次");
  });

  it("projects a loss-aware fallback only for an unknown Pi event", () => {
    const payload = { type: "future_pi_event", opaque: { value: 7 } };
    const projection = projectUnknownPiEvent(payload);

    expect(projection).toMatchObject({
      type: "future_pi_event",
      raw: payload,
    });
    expect(projection?.notice).toContain("尚未适配");
    expect(projectUnknownPiEvent({ type: "turn_end" })).toBeNull();
  });
});
