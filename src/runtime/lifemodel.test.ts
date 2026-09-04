import { describe, expect, it } from "vitest";
import {
  parseLifeModelSources,
  parseOpenCodeLifeModelSources,
} from "./lifemodel";

describe("parseLifeModelSources", () => {
  it("accepts only complete user message entries and preserves native IDs", () => {
    const parsed = parseLifeModelSources(
      {
        type: "response",
        command: "get_entries",
        success: true,
        data: {
          leafId: "assistant-entry",
          entries: [
            {
              type: "message",
              id: "user-entry",
              timestamp: "2026-08-31T00:00:00Z",
              message: {
                role: "user",
                content: [{ type: "text", text: "我偏好简洁回答。" }],
              },
            },
            {
              type: "message",
              id: "assistant-entry",
              message: { role: "assistant", content: "好的" },
            },
            { type: "custom", id: "extension-entry" },
            {
              type: "message",
              id: "missing-timestamp",
              message: { role: "user", content: "not durable enough" },
            },
          ],
        },
      },
      "farfold-session-1",
      "session-1",
    );

    expect(parsed.leafId).toBe("assistant-entry");
    expect(parsed.candidates).toEqual([
      {
        candidateId: "session-1:user-entry",
        farfoldSessionId: "farfold-session-1",
        runtimeProductId: "pi",
        nativeSessionId: "session-1",
        nativeEntryId: "user-entry",
        nativeTimestamp: "2026-08-31T00:00:00Z",
        sourceText: "我偏好简洁回答。",
      },
    ]);
  });

  it("does not manufacture provenance without a native Session", () => {
    const parsed = parseLifeModelSources(
      {
        type: "response",
        command: "get_entries",
        success: true,
        data: { entries: [] },
      },
      null,
      null,
    );
    expect(parsed).toEqual({ candidates: [], leafId: null });
  });
});

describe("parseOpenCodeLifeModelSources", () => {
  it("accepts only durable user messages from the bound native Session", () => {
    expect(
      parseOpenCodeLifeModelSources(
        [
          {
            info: {
              id: "msg_user",
              sessionID: "ses_bound",
              role: "user",
              time: { created: 1_788_111_000_000 },
            },
            parts: [
              { type: "text", text: "我偏好先给结论。" },
              { type: "text", text: "隐藏草稿", ignored: true },
            ],
          },
          {
            info: {
              id: "msg_assistant",
              sessionID: "ses_bound",
              role: "assistant",
            },
            parts: [{ type: "text", text: "收到。" }],
          },
          {
            info: {
              id: "msg_other",
              sessionID: "ses_other",
              role: "user",
            },
            parts: [{ type: "text", text: "不属于当前 Session" }],
          },
        ],
        "farfold-opencode-session",
        "ses_bound",
      ),
    ).toEqual([
      {
        candidateId: "ses_bound:msg_user",
        farfoldSessionId: "farfold-opencode-session",
        runtimeProductId: "opencode",
        nativeSessionId: "ses_bound",
        nativeEntryId: "msg_user",
        nativeTimestamp: "1788111000000",
        sourceText: "我偏好先给结论。",
      },
    ]);
  });

  it("does not manufacture provenance from malformed history", () => {
    expect(
      parseOpenCodeLifeModelSources(
        [
          { info: { role: "user" }, parts: [{ type: "text", text: "x" }] },
          {
            info: { id: "msg_empty", role: "user" },
            parts: [{ type: "tool", text: "not user text" }],
          },
          {
            info: { id: "msg_no_time", role: "user" },
            parts: [{ type: "text", text: "not durable enough" }],
          },
        ],
        "farfold-opencode-session",
        "ses_bound",
      ),
    ).toEqual([]);
    expect(parseOpenCodeLifeModelSources([], null, null)).toEqual([]);
  });
});
