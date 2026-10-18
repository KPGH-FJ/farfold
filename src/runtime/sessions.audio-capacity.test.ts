import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { largeAudioCapture } from "./audio_input.test-support";
// The exact16MiB correctness cases include full validation and persistence.
// This local runner allowance is not a product interaction/performance target.
const CAPACITY_TEST_TIMEOUT_MS = 10_000;
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  saved: null as unknown,
  prompts: [] as unknown[],
  reads: 0,
  saveAttempts: 0,
  response: { status: "accepted" } as { status: string; reason?: string },
  failQueueSave: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
let d: typeof import("./drafts"), threads: typeof import("./sessions").threads;
const capture = largeAudioCapture();
const { data, mimeType, ...localAudio } = capture;
const audio = {
  id: "audio",
  kind: "audio" as const,
  name: "sample.wav",
  uri: "file:///chosen/sample.wav",
  data,
  mimeType,
  localAudio,
};
beforeEach(async () => {
  vi.resetModules();
  h.saved = null;
  h.prompts = [];
  h.reads = 0;
  h.saveAttempts = 0;
  h.response = { status: "accepted" };
  h.failQueueSave = false;
  h.invoke.mockReset().mockImplementation(async (cmd, args) => {
    if (cmd === "settings_get") return args.key === "unsentWork.v1" ? null : 0;
    if (cmd === "settings_set") {
      if (args.key === "unsentWork.v1") {
        h.saveAttempts++;
        if (h.failQueueSave && Object.keys(args.value.queues).length)
          throw Error("controlled write failure");
        h.saved = args.value;
      }
      return;
    }
    if (cmd === "draft_attachment_audio") {
      h.reads++;
      return capture;
    }
    if (cmd === "session_prompt") {
      h.prompts.push(args.content);
      return h.response;
    }
    return [];
  });
  d = await import("./drafts");
  threads = (await import("./sessions")).threads;
  await d.draftPersistence.load();
});
afterEach(async () => {
  h.failQueueSave = false;
  d.composerDrafts.clear("new");
  d.composerDrafts.clear("resend:audio-capacity");
  d.composerDrafts.clear("session:audio-capacity");
  d.composerDrafts.clear("queue-edit:audio-capacity");
  d.draftQueues.write("audio-capacity", [], null);
  await d.draftPersistence.flush();
});
it(
  "persists one exact-16MiB independently frozen WAV with matching whole-file SHA",
  { timeout: CAPACITY_TEST_TIMEOUT_MS },
  async () => {
    expect(
      createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
    ).toBe(capture.file.sha256);
    d.composerDrafts.update("session:audio-capacity", () => ({
      text: "keep",
      attachments: [audio],
    }));
    await d.draftPersistence.flush();
    expect(d.draftPersistence.isSaved(d.draftPersistence.revision())).toBe(
      true,
    );
    expect(JSON.stringify(h.saved).length).toBeLessThan(32 * 1024 * 1024);
  },
);
it(
  "can dispatch the same allowed 16MiB audio when a send-pending composer owns it",
  { timeout: CAPACITY_TEST_TIMEOUT_MS },
  async () => {
    const state = threads.markOpenFailed(
      "audio-capacity",
      "chosen",
      "/chosen",
      "capacity",
      "controlled",
    );
    state.openError = null;
    state.workEnabled = true;
    d.composerDrafts.update(`session:${state.key}`, () => ({
      text: "keep",
      attachments: [audio],
      sendPending: true,
    }));
    await d.draftPersistence.flush();
    const { attachmentPromptBlocks } = await import("./draft_attachments");
    const blocks = attachmentPromptBlocks("keep", [audio], true);
    expect(await threads.send(state.key, blocks)).toEqual({
      status: "accepted",
    });
    expect(h.prompts).toHaveLength(1);
  },
);
it(
  "can save the unchanged queue editor for a 16MiB audio while preserving the original queued bytes",
  { timeout: CAPACITY_TEST_TIMEOUT_MS },
  async () => {
    const { attachmentPromptBlocks } = await import("./draft_attachments"),
      { startQueueEditor } = await import("./queue_edit");
    const blocks = attachmentPromptBlocks("keep", [audio], true);
    d.draftQueues.write("audio-capacity", [blocks], null);
    await d.draftPersistence.flush();
    startQueueEditor("audio-capacity", 0, blocks);
    await expect(d.draftPersistence.flush()).resolves.toBeUndefined();
    expect(
      d.composerDrafts.read("queue-edit:audio-capacity").attachments[0].data,
    ).toBe(data);
    expect(
      JSON.stringify(d.draftQueues.read("audio-capacity")?.blocks[0]) ===
        JSON.stringify(blocks),
    ).toBe(true);
  },
);

function state(first = false) {
  const s = threads.markOpenFailed(
    "audio-capacity",
    "chosen",
    "/chosen",
    "capacity",
    "controlled",
  );
  s.openError = null;
  s.workEnabled = true;
  if (first) s.identity = "draft";
  return s;
}
type CapacityPhase = "prepare" | "save" | "sendFinally" | "recovery";
function capacityTiming() {
  const started = performance.now();
  let previous = started;
  return (phase: CapacityPhase) => {
    const now = performance.now();
    console.info(
      JSON.stringify({
        phase,
        elapsedMs: now - started,
        stageMs: now - previous,
        attachmentReadCount: h.reads,
        saveAttemptCount: h.saveAttempts,
        promptCount: h.prompts.length,
      }),
    );
    previous = now;
  };
}
async function prepared(key: string, observe?: (phase: CapacityPhase) => void) {
  d.composerDrafts.update(key, () => ({
    text: "keep",
    attachments: [audio],
    sendPending: true,
  }));
  observe?.("prepare");
  await d.draftPersistence.flush();
  observe?.("save");
  return (await import("./draft_attachments")).attachmentPromptBlocks(
    "keep",
    [audio],
    true,
  );
}
it.each(["accepted", "rejected", "unknown"])(
  "retains the first pending 16MiB input through %s admission with one minimal wire payload",
  { timeout: CAPACITY_TEST_TIMEOUT_MS },
  async (status) => {
    const s = state(true),
      blocks = await prepared("new"),
      { rememberPendingConversation, finishPendingConversation } =
        await import("./pending_conversation"),
      { sendNewConversation } = await import("./new_conversation");
    h.response = {
      status,
      ...(status === "rejected" ? { reason: "audio_unsupported" } : {}),
    };
    const attempt = await rememberPendingConversation(
      "new",
      d.composerDrafts.read("new"),
      s,
    );
    if (status === "rejected")
      await expect(sendNewConversation(s.key, blocks)).rejects.toThrow();
    else await sendNewConversation(s.key, blocks);
    finishPendingConversation(
      attempt,
      status as "accepted" | "rejected" | "unknown",
    );
    await d.draftPersistence.flush();
    expect(h.prompts).toHaveLength(1);
    const wire = (h.prompts[0] as { type: string; data?: string }[])[1];
    expect(Object.keys(wire).sort()).toEqual(["data", "mimeType", "type"]);
    expect(wire.data === data).toBe(true);
    if (status !== "accepted")
      expect(d.composerDrafts.read("new").attachments[0].data === data).toBe(
        true,
      );
    if (status === "unknown") {
      expect(s.uncertainPrompt === blocks).toBe(true);
      expect(d.composerDrafts.read("new").pendingConversation).toBeTruthy();
    }
    const parsed = d.parseDraftSnapshot(h.saved)!;
    expect(parsed).toBeTruthy();
    expect(JSON.stringify(h.saved).length).toBeLessThan(32 * 1024 * 1024);
  },
);
it(
  "resend transfers a large input through the same saved queue without leaking local metadata",
  { timeout: CAPACITY_TEST_TIMEOUT_MS },
  async () => {
    const s = state(),
      blocks = await prepared("resend:audio-capacity"),
      original = d.composerDrafts.read("resend:audio-capacity");
    expect(await threads.send(s.key, blocks)).toEqual({ status: "accepted" });
    d.composerDrafts.clearIfUnchanged("resend:audio-capacity", original);
    await d.draftPersistence.flush();
    expect(h.prompts).toHaveLength(1);
    expect(d.composerDrafts.hasContent("resend:audio-capacity")).toBe(false);
  },
);
it(
  "failed queue snapshot preserves the previously saved original draft and exact in-memory source with zero prompt calls",
  { timeout: CAPACITY_TEST_TIMEOUT_MS },
  async () => {
    const observe = capacityTiming();
    const s = state(),
      blocks = await prepared("session:audio-capacity", observe),
      saved = h.saved;
    h.failQueueSave = true;
    expect(await threads.send(s.key, blocks)).toEqual({
      status: "rejected",
      reason: "failed",
    });
    observe("sendFinally");
    expect(h.saved).toBe(saved);
    expect(h.prompts).toHaveLength(0);
    expect(
      d.composerDrafts.read("session:audio-capacity").attachments[0].data ===
        data,
    ).toBe(true);
    expect(s.queued[0] === blocks).toBe(true);
    expect(d.draftPersistence.snapshot().error).toBeTruthy();
    h.failQueueSave = false;
    await d.draftPersistence.flush();
    observe("recovery");
    expect(h.prompts).toHaveLength(0);
    expect(d.draftPersistence.isSaved(d.draftPersistence.revision())).toBe(
      true,
    );
  },
);
it.each(["cancel", "confirm"])(
  "preserves queued bytes across a saved large-audio editor %s without automatic dispatch",
  { timeout: CAPACITY_TEST_TIMEOUT_MS },
  async (action) => {
    const s = state(),
      { attachmentPromptBlocks } = await import("./draft_attachments"),
      { startQueueEditor } = await import("./queue_edit");
    s.running = true;
    const blocks = attachmentPromptBlocks("keep", [audio], true);
    expect(await threads.send(s.key, blocks)).toEqual({ status: "queued" });
    s.running = false;
    threads.beginQueueEdit(s.key, 0);
    startQueueEditor(s.key, 0, blocks);
    await d.draftPersistence.flush();
    if (action === "confirm") {
      const editor = d.composerDrafts.read("queue-edit:audio-capacity");
      threads.replaceQueued(
        s.key,
        blocks,
        attachmentPromptBlocks("edited", editor.attachments, true),
      );
    }
    d.composerDrafts.clear("queue-edit:audio-capacity");
    await d.draftPersistence.flush();
    expect(s.queued[0][1].type).toBe("audio");
    expect((s.queued[0][1] as { data: string }).data === data).toBe(true);
    expect(h.prompts).toHaveLength(0);
  },
);
