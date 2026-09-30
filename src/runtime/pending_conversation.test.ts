import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ open: vi.fn(), thread: vi.fn() }));
vi.mock("./sessions", () => ({ threads: h }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { composerDrafts, draftPersistence, type ComposerDraft } from "./drafts";
import { freshThreadState } from "./session_projection";
import {
  rememberPendingConversation,
  finishPendingConversation,
  recoverPendingConversation,
  abandonPendingConversation,
} from "./pending_conversation";
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.open.mockReset();
  h.thread.mockReset();
  composerDrafts.clear("new");
});
afterEach(() => vi.restoreAllMocks());
function input(): ComposerDraft {
  composerDrafts.update("new", () => ({
    text: "first message",
    attachments: [],
    sendPending: true,
  }));
  return composerDrafts.read("new");
}
function state() {
  const s = freshThreadState(
    "selected:/canonical/work:native-1",
    "selected",
    "/canonical/work",
    "native-1",
  );
  s.service = { id: "api-1", model: "chosen", fingerprint: "identity" };
  s.serviceContext = "revision-1";
  return s;
}
it("saves the actual native target before the first request can proceed", async () => {
  let saved!: () => void;
  vi.mocked(draftPersistence.flush).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  let finished = false;
  const preparing = rememberPendingConversation("new", input(), state()).then(
    (value) => {
      finished = true;
      return value;
    },
  );
  expect(composerDrafts.read("new").pendingConversation).toEqual({
    agentId: "selected",
    cwd: "/canonical/work",
    nativeSessionId: "native-1",
    service: { id: "api-1", model: "chosen" },
    serviceRevision: "revision-1",
  });
  expect(finished).toBe(false);
  saved();
  const attempt = await preparing;
  finishPendingConversation(attempt, "unknown");
  expect(composerDrafts.read("new").sendPending).toBe(true);
  expect(h.open).not.toHaveBeenCalled();
});
it("retains rejected input and never erases typing that arrived before or after target saving", async () => {
  let original = input();
  let attempt = await rememberPendingConversation("new", original, state());
  finishPendingConversation(attempt, "rejected");
  expect(composerDrafts.read("new")).toMatchObject({
    text: "first message",
    sendPending: false,
  });
  expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
  original = input();
  composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "later before target",
  }));
  attempt = await rememberPendingConversation("new", original, state());
  finishPendingConversation(attempt, "accepted");
  expect(composerDrafts.read("new").text).toBe("later before target");
  original = input();
  attempt = await rememberPendingConversation("new", original, state());
  composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "later after target",
  }));
  finishPendingConversation(attempt, "accepted");
  expect(composerDrafts.read("new").text).toBe("later after target");
  expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
});
it("does not dispatch after save failure and clears accepted unchanged input", async () => {
  vi.mocked(draftPersistence.flush).mockRejectedValueOnce(
    new Error("save failed"),
  );
  await expect(
    rememberPendingConversation("new", input(), state()),
  ).rejects.toThrow("save failed");
  expect(composerDrafts.read("new").text).toBe("first message");
  expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
  const attempt = await rememberPendingConversation("new", input(), state());
  finishPendingConversation(attempt, "accepted");
  expect(composerDrafts.read("new").text).toBe("");
});
it("recovers only the saved native identity without sending or changing its source", async () => {
  const attempt = await rememberPendingConversation("new", input(), state());
  h.open.mockResolvedValue({ key: "selected:/canonical/work:native-1" });
  expect(await recoverPendingConversation(attempt.target)).toBe(
    "selected:/canonical/work:native-1",
  );
  expect(h.open).toHaveBeenCalledWith({ ...attempt.target });
  h.open.mockReset();
  h.thread.mockReturnValue(state());
  await recoverPendingConversation(attempt.target);
  expect(h.open).not.toHaveBeenCalled();
});
it("keeps the pointer and input on recovery failure until explicit abandonment", async () => {
  const attempt = await rememberPendingConversation("new", input(), state());
  h.open.mockRejectedValue(new Error("History unavailable"));
  await expect(recoverPendingConversation(attempt.target)).rejects.toThrow(
    "History unavailable",
  );
  expect(composerDrafts.read("new")).toBe(attempt.snapshot);
  abandonPendingConversation("new", { ...attempt.target });
  expect(composerDrafts.read("new").pendingConversation).toBe(attempt.target);
  abandonPendingConversation("new", attempt.target);
  expect(composerDrafts.read("new")).toMatchObject({
    text: "first message",
    sendPending: false,
  });
  expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
});

it("does not send after explicit abandonment while the target save is in flight", async () => {
  let saved!: () => void;
  vi.mocked(draftPersistence.flush).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  const attempt = rememberPendingConversation("new", input(), state());
  const target = composerDrafts.read("new").pendingConversation!;
  abandonPendingConversation("new", target);
  saved();
  await expect(attempt).rejects.toThrow("消息尚未发送");
  expect(composerDrafts.read("new").text).toBe("first message");
  expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
});
