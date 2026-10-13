import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), verify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
vi.mock("./document_input", () => ({ verifyDocumentInput: h.verify }));
import { threads, normalizeConfigOptions } from "./sessions";
import { draftPersistence, composerDrafts, draftQueues } from "./drafts";
import { archiveActivity } from "./archive_activity";
import { documentBlock } from "./docx_draft.test-support";
import { startQueueEditor, queueEditorKey } from "./queue_edit";
import {
  userMessageBlocks,
  userMessageDraftAttachments,
} from "./message_actions";
import { localMessageAttachments } from "./prompt_blocks";
import type { PromptBlock } from "./session_types";
import { freshThreadState } from "./session_projection";

const effect = {
  configId: "mode",
  appliesAt: "next_ordinary_prompt",
  currentScope: "unknown",
};
const option = (value = "ask") => [
  {
    id: "mode",
    category: "mode",
    type: "select",
    name: "Permission",
    currentValue: value,
    options: [
      { value: "ask", name: "Ask" },
      { value: "read", name: "Read" },
    ],
  },
];
const configured = (value = "ask", fact: unknown = effect) => ({
  configOptions: option(value),
  configCheck: { status: "ready", issues: [], current: {} },
  permissionConfigId: "mode",
  permissionState: "ready",
  permissionEffect: fact,
  service: null,
});
let serial = 0;
function seed() {
  const id = `permission-scope-${++serial}`;
  const s = threads.markOpenFailed(id, "controlled", "/owned", id, "fixture");
  s.openError = null;
  s.permissionConfigId = "mode";
  s.permissionState = "ready";
  s.configOptions = normalizeConfigOptions(option());
  return s;
}
const event = (key: string, value: unknown) =>
  (
    threads as unknown as {
      applyChannelEvent(key: string, value: unknown): void;
    }
  ).applyChannelEvent(key, value);
beforeEach(() => {
  h.invoke
    .mockReset()
    .mockImplementation(async (command) =>
      command === "session_prompt"
        ? { status: "accepted" }
        : command === "settings_get"
          ? 0
          : [],
    );
  h.verify.mockReset().mockResolvedValue(undefined);
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

it("matching choice ACK and ordinary completion retain unknown current scope without resuming old queue", async () => {
  const s = seed();
  s.permissionState = "required";
  const queued: PromptBlock[] = [
    { type: "text", text: "/review" },
    documentBlock(),
  ];
  s.queued = [queued];
  h.invoke.mockImplementation(async (command) =>
    command === "session_set_config" ? configured() : [],
  );
  await threads.setConfig(s.key, "mode", "ask");
  expect(s.permissionState).toBe("ready");
  expect(s.permissionEffect).toEqual(effect);
  expect(s.queued[0]).toBe(queued);
  expect(s.queuePaused).toBe("stopped");
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(0);
  s.queued = [];
  s.queuePaused = null;
  h.invoke.mockImplementation(async (command) =>
    command === "session_prompt" ? { status: "accepted" } : [],
  );
  await threads.send(s.key, [{ type: "text", text: "ordinary" }]);
  event(s.key, { kind: "turnEnd", stopReason: "end_turn" });
  expect(s.permissionEffect).toEqual(effect);
});

it("generic effect events never make required/unknown choices ready and never accept forged current scope", () => {
  const s = seed();
  s.permissionState = "required";
  event(s.key, {
    kind: "permissionState",
    permissionConfigId: "mode",
    permissionState: "ready",
    permissionEffect: effect,
  });
  expect(s.permissionState).toBe("required");
  expect(s.permissionEffect).toEqual(effect);
  event(s.key, {
    kind: "permissionState",
    permissionConfigId: "mode",
    permissionState: "unknown",
    permissionEffect: { ...effect, currentScope: "verified" },
  });
  expect(s.permissionState).toBe("unknown");
  expect(s.permissionEffect).toBeUndefined();
  event(s.key, {
    kind: "permissionState",
    permissionConfigId: "mode",
    permissionState: "ready",
    permissionEffect: { ...effect, configId: "other" },
  });
  expect(s.permissionState).toBe("unknown");
  expect(s.permissionEffect).toBeUndefined();
});

it("definite scope rejection preserves exact queued input and approved attachment, with no implicit retry", async () => {
  const s = seed();
  const text = "\ufeff /ReViEw\u00a0target\n";
  const blocks: PromptBlock[] = [{ type: "text", text }, documentBlock()];
  h.invoke.mockImplementation(async (command) =>
    command === "session_prompt"
      ? { status: "rejected", reason: "permission_scope_unverified" }
      : [],
  );
  expect(await threads.send(s.key, blocks)).toEqual({
    status: "rejected",
    reason: "permission_scope_unverified",
  });
  expect(s.queued[0]).toBe(blocks);
  expect(s.queued[0]).toEqual(blocks);
  expect(draftQueues.read(s.key)?.blocks).toEqual([blocks]);
  expect(s.uncertainPrompt).toBeNull();
  expect(s.connectionOutcomeUnknown).toBe(false);
  expect(s.queuePaused).toBe("unavailable");
  expect(s.items.some((item) => item.kind === "user")).toBe(false);
  expect(
    s.items.some(
      (item) =>
        item.kind === "notice" &&
        item.message ===
          "当前完整权限尚无法确认，此命令暂不能发送。原输入已保留。",
    ),
  ).toBe(true);
  event(s.key, {
    kind: "permissionState",
    permissionConfigId: "mode",
    permissionState: "ready",
    permissionEffect: effect,
  });
  await Promise.resolve();
  const calls = h.invoke.mock.calls.filter(
    ([command]) => command === "session_prompt",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0][1].content[0].text).toBe(text);
  expect(JSON.stringify(calls[0][1].content)).not.toContain(
    "localDocumentText",
  );
});

it("queue edit, resend and new-message reconstruction retain the blocked command and its document authority", async () => {
  const original: PromptBlock[] = [
    { type: "text", text: "/review-branch exact-branch" },
    documentBlock(),
  ];
  const attachments = localMessageAttachments(original);
  const resent = userMessageBlocks("/review-branch exact-branch", attachments);
  const draftAttachments = userMessageDraftAttachments(attachments);
  expect(draftAttachments[0].documentText?.local).toEqual(
    documentBlock().localDocumentText,
  );
  for (const blocks of [original, resent]) {
    const s = seed();
    h.invoke.mockImplementation(async (command) =>
      command === "session_prompt"
        ? { status: "rejected", reason: "permission_scope_unverified" }
        : [],
    );
    await threads.send(s.key, blocks);
    expect(s.queued[0]).toBe(blocks);
    startQueueEditor(s.key, 0, blocks);
    const draft = composerDrafts.read(queueEditorKey(s.key));
    expect(draft.text).toBe("/review-branch exact-branch");
    expect(draft.attachments[0].documentText?.local).toEqual(
      documentBlock().localDocumentText,
    );
    expect(s.queuePaused).toBe("unavailable");
    expect(s.uncertainPrompt).toBeNull();
    composerDrafts.clear(queueEditorKey(s.key));
  }
});

it("late matching config cannot cross a replacement owner and a disconnect retires the old timing fact", async () => {
  const s = seed();
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = threads.setConfig(s.key, "mode", "ask");
  const replacement = freshThreadState(
    s.key,
    s.agentId,
    s.cwd,
    s.nativeSessionId,
  );
  (threads as unknown as { threads: Map<string, typeof s> }).threads.set(
    s.key,
    replacement,
  );
  finish(configured());
  await expect(pending).rejects.toBeTruthy();
  expect(replacement.permissionEffect).toBeUndefined();
  expect(replacement.permissionState).toBe("ready");
  expect(replacement.configError).toBeNull();
  const live = seed();
  event(live.key, {
    kind: "permissionState",
    permissionConfigId: "mode",
    permissionState: "ready",
    permissionEffect: effect,
  });
  expect(live.permissionEffect).toEqual(effect);
  event(live.key, { kind: "connectionLost", closeReason: "unexpected" });
  expect(live.permissionEffect).toBeUndefined();
});

it("a matching setter without timing facts clears earlier facts instead of guessing the same route", async () => {
  const s = seed();
  event(s.key, {
    kind: "permissionState",
    permissionConfigId: "mode",
    permissionState: "ready",
    permissionEffect: effect,
  });
  h.invoke.mockResolvedValue(configured("ask", null));
  await threads.setConfig(s.key, "mode", "ask");
  expect(s.permissionState).toBe("ready");
  expect(s.permissionEffect).toBeUndefined();
  expect(s.queuePaused).toBe("stopped");
});

it("lost admission remains unknown and retains the same uncertain input instead of becoming a scope rejection", async () => {
  const s = seed();
  const blocks: PromptBlock[] = [
    { type: "text", text: "/review" },
    documentBlock(),
  ];
  h.invoke.mockRejectedValue(new Error("controlled lost admission"));
  expect((await threads.send(s.key, blocks)).status).toBe("unknown");
  expect(s.uncertainPrompt).toBe(blocks);
  expect(s.queuePaused).toBe("uncertain");
  expect(s.connectionOutcomeUnknown).toBe(true);
  expect(s.queued[0]).toBe(blocks);
});
