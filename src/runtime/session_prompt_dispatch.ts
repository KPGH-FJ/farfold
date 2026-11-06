import { invoke } from "@tauri-apps/api/core";
import { beginSuccessDesktopNotification } from "./desktop_notifications";
import { archiveActivity } from "./archive_activity";
import { composerDrafts, draftPersistence } from "./drafts";
import { validateQueuedAttachments } from "./draft_attachments";
import {
  localMessageAttachments,
  wirePromptBlocks,
  titleFromBlocks,
  promptText,
  promptRejectionItem,
} from "./prompt_blocks";
import {
  canDrain,
  pauseQueue,
  removeQueued,
  type PromptAdmission,
} from "./queue";
import { nextItemId, sealStreams } from "./session_projection";
import { STRINGS } from "./strings";
import { uiError } from "./ui_error";
import type { ThreadState, ThreadItem } from "./session_types";
import type { StopConfirmation } from "./stop_confirmation";
import { PromptRequestOwner } from "./prompt_admission";
type SendAdmission = PromptAdmission | { status: "queued" };
export interface PromptHooks {
  thread(key: string): ThreadState | undefined;
  emit(key?: string): void;
  stop: StopConfirmation;
  owners: WeakMap<ThreadState, PromptRequestOwner>;
  retireDraft(s: ThreadState): void;
  refreshIndex(): Promise<unknown>;
  finishArchive(s: ThreadState): void;
  drain(key: string): Promise<SendAdmission>;
}
export async function drainPrompt(
  key: string,
  hooks: PromptHooks,
): Promise<SendAdmission> {
  const s = hooks.thread(key);
  if (!s || !canDrain(s) || composerDrafts.read(`queue-edit:${key}`).queueEdit)
    return { status: "queued" };
  const blocks = s.queued[0];
  const finishPreparation = hooks.stop.prepare(s);
  s.submitting = true;
  s.running = false;
  const firstPrompt = s.identity === "draft";
  sealStreams(s);
  const text = promptText(blocks);
  const item: ThreadItem = {
    kind: "user",
    id: nextItemId(),
    text,
    attachments: [],
    streaming: false,
    time: Date.now(),
  };
  s.items.push(item);
  s.roundItemBase = s.items.length;
  beginSuccessDesktopNotification(s, () => hooks.thread(key) === s);
  hooks.emit();
  let dispatched = false;
  const receivedEnding = () =>
    s.items
      .slice(s.roundItemBase)
      .some(
        (entry) =>
          entry.kind === "settled" && entry.replyReceived !== undefined,
      );
  const admit = () => {
    removeQueued(s, blocks);
    if (s.uncertainPrompt === blocks) s.uncertainPrompt = null;
    s.identity = "established";
    hooks.retireDraft(s);
    if (firstPrompt && !s.title) {
      s.title = titleFromBlocks(blocks);
      void invoke("session_touch", {
        agentId: s.agentId,
        cwd: s.cwd,
        sessionId: s.nativeSessionId,
        title: s.title,
        configOptions: null,
      })
        .then(() => hooks.refreshIndex())
        .catch(() => undefined);
    }
  };
  try {
    await validateQueuedAttachments(blocks);
    // Project checked dispatch content, not the earlier queue snapshot.
    item.attachments = localMessageAttachments(blocks);
    // Persist the in-flight input before it can reach an Agent. A crash in
    // this window restores an explicitly quarantined request, never a retry.
    hooks.emit(key);
    await draftPersistence.flush();
    await archiveActivity.begin(key);
    if (
      hooks.thread(key) !== s ||
      composerDrafts.read(`queue-edit:${key}`).queueEdit ||
      !canDrain({ ...s, running: false, submitting: false })
    ) {
      s.running = false;
      s.items = s.items.filter((i) => i !== item);
      if (s.uncertainPrompt === blocks) s.uncertainPrompt = null;
      if (firstPrompt) s.identity = "draft";
      return { status: "rejected", reason: "unavailable" };
    }
    const content = wirePromptBlocks(blocks);
    let owner!: PromptRequestOwner;
    owner = new PromptRequestOwner(
      s,
      () => hooks.thread(key) === s && hooks.owners.get(s) === owner,
      () => hooks.emit(),
      finishPreparation,
      () => {
        if (hooks.owners.get(s) === owner) hooks.owners.delete(s);
      },
      () => {
        // The matched stop receipt can arrive before the offer or admission.
        // Observe its outcome without sending another stop or accepting input.
        if (s.stopping) return;
        s.stopping = true;
        hooks.stop.start(
          s,
          () => hooks.thread(key),
          () => hooks.emit(),
          true,
        );
      },
    );
    hooks.owners.set(s, owner);
    dispatched = true;
    const result = await invoke<PromptAdmission>("session_prompt", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
      content,
      connectionId: s.connectionId ?? null,
      expectedCurrent: s.configCheck?.current ?? null,
      promptToken: owner.token,
      admissionChannel: owner.channel,
    });
    if (hooks.thread(key) !== s) return result;
    if (
      result.status === "accepted" ||
      (result.status === "unknown" && receivedEnding())
    ) {
      // The result channel can beat the admission reply. A real ending proves
      // delivery, even if the later admission reply was lost; it proves no success.
      // An owned error ending can beat this admission reply. Delivery is
      // confirmed, but its settled round must not become running again.
      if (!receivedEnding()) owner.accepted();
      admit();
      return { status: "accepted" };
    } else {
      s.running = false;
      if (result.status === "unknown") {
        s.identity = "established";
        s.uncertainPrompt = blocks;
        s.connectionOutcomeUnknown = true;
        pauseQueue(s, "uncertain");
      } else {
        // Rejected admission proves this prompt never began; no completion
        // can arrive to settle a stop requested while its reply was pending.
        hooks.owners.get(s)?.end();
        hooks.stop.clear(key);
        s.stopping = false;
        s.stopUnconfirmed = false;
        s.items = s.items.filter((i) => i !== item);
        const notice = promptRejectionItem(result, nextItemId);
        if (notice) s.items.push(notice);
        pauseQueue(
          s,
          result.reason === "send_wait_cancelled"
            ? "stopped"
            : result.reason === "work_disabled"
              ? "work_disabled"
              : result.reason === "failed"
                ? "failed"
                : "unavailable",
        );
      }
    }
    return result;
  } catch (error) {
    if (hooks.thread(key) !== s) return { status: "unknown" };
    if (dispatched && receivedEnding()) {
      admit();
      return { status: "accepted" };
    }
    if (!dispatched) {
      s.running = false;
      s.items = s.items.filter((i) => i !== item);
      if (s.uncertainPrompt === blocks) s.uncertainPrompt = null;
      if (firstPrompt) s.identity = "draft";
      pauseQueue(s, "failed");
      if (!firstPrompt)
        s.items.push({
          kind: "notice",
          id: nextItemId(),
          message: uiError(error, STRINGS.repair.sendFailed),
          time: Date.now(),
        });
      return { status: "rejected", reason: "failed" };
    }
    // IPC failure may happen after dispatch: never automatically repeat it.
    s.running = false;
    s.identity = "established";
    s.uncertainPrompt = blocks;
    s.connectionOutcomeUnknown = true;
    pauseQueue(s, "uncertain");
    return { status: "unknown" };
  } finally {
    finishPreparation();
    s.submitting = false;
    hooks.emit();
    hooks.finishArchive(s);
    // A failed post-admission save must not turn a dispatched message into
    // "unsent". The global save state retains the error for explicit retry.
    await draftPersistence.flush().catch(() => undefined);
    if (canDrain(s)) void hooks.drain(key);
  }
}
