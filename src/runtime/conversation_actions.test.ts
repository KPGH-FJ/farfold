import { expect, it } from "vitest";
import type { Credential } from "./credentials";
import type { ThreadState } from "./sessions";
import {
  exportFileName,
  storedConversationSelection,
  transcriptMarkdown,
} from "./conversation_actions";

const credential = (id: string, revision = "r1"): Credential => ({
  id,
  label: id,
  provider: "custom",
  endpoint: "https://example.test",
  apiType: "responses",
  models: ["m"],
  revision,
  complete: true,
  deleting: false,
  grants: [],
});

it("reads a recorded confirmed selection for reopen-with-same-settings", () => {
  const saved = {
    _farfoldConfig: 2,
    choices: [
      { id: "model", category: "model", type: "select", value: "m9" },
      {
        id: "reasoning",
        category: "thought_level",
        type: "select",
        value: "high",
      },
    ],
    _farfoldService: {
      kind: "configured",
      identity: { id: "svc", model: "api-x" },
    },
  };
  expect(storedConversationSelection(saved, [credential("svc", "r9")])).toEqual(
    {
      service: { id: "svc", model: "api-x", revision: "r9" },
      config: { model: "m9", reasoning: "high" },
    },
  );
});

it("keeps a deleted or changed service visible with an empty revision instead of silently dropping it", () => {
  const saved = {
    _farfoldConfig: 2,
    choices: [],
    _farfoldService: {
      kind: "configured",
      identity: { id: "gone", model: "api-x" },
    },
  };
  expect(storedConversationSelection(saved, [])).toEqual({
    service: { id: "gone", model: "api-x", revision: "" },
    config: {},
  });
});

it("treats an existing-settings record and unknown shapes as plain selections", () => {
  const existing = {
    _farfoldConfig: 2,
    choices: [{ id: "model", category: "model", type: "select", value: "m1" }],
    _farfoldService: { kind: "existing" },
  };
  expect(storedConversationSelection(existing, [])).toEqual({
    service: null,
    config: { model: "m1" },
  });
  for (const shape of [null, "text", [], { _farfoldConfig: 1 }, 42])
    expect(storedConversationSelection(shape, [])).toEqual({
      service: null,
      config: {},
    });
});

it("exports the readable surface as Markdown without collapsed technical detail", () => {
  const thread = {
    items: [
      {
        kind: "user",
        id: "u1",
        text: "看下这个项目",
        attachments: [
          { kind: "resource", name: "note.txt", uri: "/work/note.txt" },
        ],
        streaming: false,
        time: 1,
      },
      {
        kind: "tool",
        id: "t1",
        call: {
          toolCallId: "t1",
          title: "raw title stays inside",
          kind: "read",
          status: "completed",
          locations: [{ path: "/work/a.ts" }],
          content: [{ type: "text" as const, text: "SECRET-DETAIL" }],
          rawInput: { hidden: true },
          startedAt: 0,
        },
      },
      {
        kind: "agent",
        id: "a1",
        text: "已经看过文件了。",
        streaming: false,
        time: 2,
      },
      {
        kind: "settled",
        id: "s1",
        status: "stopped",
        diffCount: 0,
        artifactCount: 0,
        time: 3,
      },
    ],
  } as unknown as Pick<ThreadState, "items">;
  const markdown = transcriptMarkdown(thread, "对话标题", "Codex");
  expect(markdown).toContain("# 对话标题");
  expect(markdown).toContain("**你**");
  expect(markdown).toContain("看下这个项目");
  expect(markdown).toContain("note.txt — /work/note.txt");
  expect(markdown).toContain("- 查看了文件 — /work/a.ts");
  expect(markdown).toContain("**Codex**");
  expect(markdown).toContain("已经看过文件了。");
  expect(markdown).toContain("> 已停止");
  // Collapsed technical details never reach the export.
  expect(markdown).not.toContain("SECRET-DETAIL");
  expect(markdown).not.toContain("raw title stays inside");
  expect(markdown).not.toContain("hidden");
});

it("names export files safely from the conversation title", () => {
  expect(exportFileName("整理 src/a.ts: 讨论?")).toBe("整理 src a.ts 讨论.md");
  expect(exportFileName("   ")).toBe("未命名会话.md");
  expect(exportFileName("x".repeat(100)).endsWith(".md")).toBe(true);
  expect(exportFileName("x".repeat(100)).length).toBe(63);
});
