import { observeAuthentication } from "./authentication";
import { applyConfigCheck, type ConfigCheck } from "./config_check";
/**
 * Thread/session client: invoke wrappers over the session commands, a
 * store holding every open conversation's normalized transcript state,
 * and the pure `applyUpdate` projection that maps raw agent updates onto
 * thread items.
 *
 * Wire shapes mirror `acp_client/session_commands.rs`,
 * `acp_client/pump.rs` and `meta_store.rs` (camelCase). Raw updates arrive
 * over a per-conversation `Channel` as `{sessionId, update}` envelopes;
 * side-band events carry `kind`: `permissionRequest` | `elicitation` |
 * `interactionsCancelled` | `turnEnd` | `connectionLost` | `notification`.
 *
 * Naming note: user-facing vocabulary is "会话/thread"; `session*` stays
 * inside this runtime module only (AGENTS.md vocabulary rule).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useSyncExternalStore } from "react";
import { paneCards, appendToolOutput } from "./artifacts";
import { artifactPaneCards } from "./artifact_view";
import type { PaneCard } from "./artifacts";
import { STRINGS } from "./strings";
import { InteractionActions } from "./interaction_actions";
import { StopConfirmation } from "./stop_confirmation";
import {
  composerDrafts,
  draftQueues,
  draftPersistence,
  hasUnsentWork,
} from "./drafts";
import {
  hasReadableMessages,
  normalizeMessageAttachment,
} from "./message_attachments";
import { validateQueuedAttachments } from "./draft_attachments";
import {
  markRestoredQueueAttachments,
  queuedAttachmentsNeedReview,
} from "./recovered_attachments";
import { keepPromptAsDraft } from "./uncertain_prompt";
import { archiveActivity } from "./archive_activity";
import { settledRoundResults } from "./round_result";
import { uiError } from "./ui_error";
import {
  canDrain,
  canReleaseEmptyQueuePause,
  pauseQueue,
  removeQueued,
  type PromptAdmission,
} from "./queue";

export type { PaneCard };
export { paneCards };

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** meta_store session row (`<agentId>:<cwd>:<nativeSessionId>`). */
export interface IndexRow {
  id: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string | null;
  title: string | null;
  configOptions: unknown | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/** `session_open` result. */
export interface OpenResult {
  nativeSessionId: string;
  /** Canonicalized cwd — session keys must be built from this. */
  cwd: string;
  configOptions: unknown;
  modes?: unknown;
  models?: unknown;
  meta?: unknown;
  resumed: boolean;
  warnings: string[];
  configCheck?: ConfigCheck;
  permissionConfigId?: string;
  permissionState?: ThreadState["permissionState"];
  service?: import("./credentials").ServiceIdentity | null;
  serviceContext?: string | null;
}

/** External conversation shape accepted by the sidebar grouping helper. */
export interface AgentOnlyRow {
  key: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  title: string | null;
  updatedAt: number;
}

/** View-model types live in `session_types.ts` (file-size cap); re-export
 *  so `../runtime/sessions` imports keep working. */
import type {
  Attachment,
  PromptBlock,
  ThreadItem,
  ThreadState,
} from "./session_types";
import { hasActiveTools, hasPendingRequests } from "./session_types";
export * from "./session_types";
export {
  freshThreadState,
  applyElicitation,
  applyUpdate,
  applyTurnEnd,
  applyConnectionLost,
  normalizeConfigOptions,
  modelConfigOption,
  modelValueOf,
  storedModelValue,
  configValueLabel,
  synthesizeModeOption,
} from "./session_projection";
import {
  freshThreadState,
  applyElicitation,
  clearPendingRequests,
  expirePendingRequest,
  applyUpdate,
  applyTurnEnd,
  applyConnectionLost,
  normalizeConfigOptions,
  modelConfigOption,
  modelValueOf,
  synthesizeModeOption,
  applyPermissionRequest,
  nextItemId,
  sealStreams,
  pushRaw,
} from "./session_projection";
import { ThreadNotifications } from "./thread_notifications";
import { conversationReadState } from "./conversation_read_state";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ThreadsSnapshot {
  version: number;
  threads: Map<string, ThreadState>;
  index: IndexRow[];
  /** `settings.autoArchiveDays` (0 = off). */
  autoArchiveDays: number;
}

/** Default auto-archive window when the setting is unset (days). */
export const DEFAULT_AUTO_ARCHIVE_DAYS = 30;

interface OpenInput {
  agentId: string;
  cwd: string;
  nativeSessionId?: string;
  configOptions?: Record<string, unknown> | null;
  fresh?: boolean;
  /** Separate preparation drafts from the ordinary unsent conversation. Memory only. */
  draftScope?: string;
  service?: import("./credentials").ServiceSelection | null;
  serviceRevision?: string;
}

function draftGroup(input: OpenInput): string {
  return `${input.agentId}|${input.cwd}|${JSON.stringify(input.service ?? null)}|${input.serviceRevision ?? ""}|${input.draftScope ?? ""}`;
}

export type SendAdmission = PromptAdmission | { status: "queued" };

function titleFromBlocks(blocks: PromptBlock[]): string {
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 40);
}

class ThreadsStore {
  private threads = new Map<string, ThreadState>();
  private indexRows: IndexRow[] = [];
  private autoArchiveDays = 0;
  private archiveRevision = 0;
  private archiveWrite: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private notifications = new ThreadNotifications();
  subscribeThread = (key: string, fn: () => void) =>
    this.notifications.subscribe(key, fn);
  threadVersion = (key: string) => this.notifications.version(key);
  private snapshot: ThreadsSnapshot = {
    version: 0,
    threads: this.threads,
    index: this.indexRows,
    autoArchiveDays: this.autoArchiveDays,
  };
  /** channel kept alive per thread key. */
  private channels = new Map<string, Channel<unknown>>();
  private permissionRevisions = new Map<string, number>();
  /** dedupe concurrent opens (same agent+cwd+native target). */
  private openings = new Map<string, Promise<ThreadState>>();
  /** Unprompted ("draft") conversations per agent+cwd — re-picking the
   *  same pair reuses the draft instead of spawning another session. */
  private drafts = new Map<string, string>();
  private interactions = new InteractionActions(
    (key) => this.thread(key),
    (key) => this.emit(key),
  );
  private configRequests = new Map<string, Promise<void>>();
  private recordedEndings = new WeakSet<ThreadItem>();
  decidePermission = (
    key: string,
    requestId: string,
    optionId: string,
    label: string,
    allow: boolean,
    remember = false,
  ): void =>
    this.interactions.decide(key, requestId, optionId, label, allow, remember);
  undoPermissionDecision = (key: string, requestId: string): void =>
    this.interactions.undo(key, requestId);

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ThreadsSnapshot => this.snapshot;

  private emit(key?: string): void {
    for (const state of key ? [this.thread(key)] : this.threads.values()) {
      if (!state) continue;
      const uncertain =
        state.uncertainPrompt ?? (state.submitting ? state.queued[0] : null);
      draftQueues.write(
        state.key,
        state.queued,
        uncertain ? state.queued.indexOf(uncertain) : null,
      );
    }
    this.notifications.flush(key);
    this.snapshot = {
      version: this.snapshot.version + 1,
      threads: this.threads,
      index: this.indexRows,
      autoArchiveDays: this.autoArchiveDays,
    };
    for (const fn of this.listeners) fn();
  }

  thread(key: string): ThreadState | undefined {
    return this.threads.get(key);
  }

  private finishArchiveActivity(s: ThreadState): void {
    if (
      this.thread(s.key) !== s ||
      s.running ||
      s.submitting ||
      s.stopping ||
      s.stopUnconfirmed ||
      s.connectionLost ||
      s.connectionOutcomeUnknown ||
      s.uncertainPrompt ||
      s.activeToolCallIds.length ||
      hasPendingRequests(s) ||
      (s.permissionConfigId && s.permissionState !== "ready")
    )
      return;
    const end = s.items
      .slice()
      .reverse()
      .find((item) => item.kind === "settled");
    // Only endings observed in this execution carry replyReceived. A history
    // replay or an old index timestamp cannot manufacture a terminal receipt.
    if (
      !end ||
      end.kind !== "settled" ||
      end.replyReceived === undefined ||
      end.status === "unknown" ||
      this.recordedEndings.has(end)
    )
      return;
    if (
      end.status === "done" &&
      !["reply", "tool"].includes(settledRoundResults(s).get(end.id) ?? "none")
    )
      return;
    this.recordedEndings.add(end);
    void archiveActivity
      .finish(s.key)
      .catch(() => this.recordedEndings.delete(end));
  }

  private restoreQueue(state: ThreadState): void {
    const saved = draftQueues.read(state.key);
    if (!saved) return;
    state.queued = saved.blocks;
    markRestoredQueueAttachments(state.queued);
    state.uncertainPrompt =
      saved.uncertainIndex === null
        ? null
        : (saved.blocks[saved.uncertainIndex] ?? null);
    state.queuePaused = state.uncertainPrompt ? "uncertain" : "stopped";
  }

  needsAttention(s: ThreadState): boolean {
    return (
      Boolean(s.openError) ||
      s.unrecoverable ||
      s.stopUnconfirmed ||
      s.modelDrift ||
      Boolean(
        s.permissionConfigId &&
        ["required", "unknown"].includes(s.permissionState),
      ) ||
      Boolean(s.uncertainPrompt) ||
      s.queuePaused === "no_result" ||
      hasPendingRequests(s) ||
      s.connectionOutcomeUnknown
    );
  }

  setAutoArchiveDays(days: number): Promise<void> {
    const write = this.archiveWrite.then(async () => {
      await invoke("settings_set", { key: "autoArchiveDays", value: days });
      this.archiveRevision++;
      this.autoArchiveDays = days;
      this.emit();
    });
    this.archiveWrite = write.catch(() => undefined);
    return write;
  }

  async readAutoArchiveDays(): Promise<number> {
    await this.archiveWrite;
    const revision = this.archiveRevision;
    const days = await invoke<unknown>("settings_get", {
      key: "autoArchiveDays",
    });
    if (revision !== this.archiveRevision) return this.autoArchiveDays;
    return typeof days === "number" && Number.isFinite(days) && days >= 0
      ? Math.floor(days)
      : DEFAULT_AUTO_ARCHIVE_DAYS;
  }

  async refreshIndex(): Promise<void> {
    const archiveRevision = this.archiveRevision;
    try {
      this.indexRows = await invoke<IndexRow[]>("session_index_list");
    } catch {
      // Keep the last known index; a failed read must not blank the sidebar.
    }
    // Metadata refresh stays local. Agent history is queried only through
    // the explicit discovery flow, never as a side effect of rename/pin/archive.
    try {
      const days = await this.readAutoArchiveDays();
      if (archiveRevision === this.archiveRevision) {
        this.autoArchiveDays = days;
      }
    } catch {
      // A failed read cannot replace a confirmed setting with an invented default.
    }
    this.emit();
  }

  private applyChannelEvent(key: string, event: unknown, live = true): void {
    const s = this.threads.get(key);
    if (!s || !event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    if (e.kind === "configCheck") {
      applyConfigCheck(s, e.check as ConfigCheck);
    } else if (e.kind === "toolActivity" && Array.isArray(e.toolCallIds)) {
      // Process exit ends local activity, but is not a successful tool result.
      if (e.reason === "process_ended" && s.activeToolCallIds.length > 0)
        s.connectionOutcomeUnknown = true;
      s.activeToolCallIds = e.toolCallIds.filter(
        (id): id is string => typeof id === "string",
      );
      this.finishArchiveActivity(s);
    } else if (e.kind === "permissionState") {
      // Only the explicit setter's matching reply may enable sending. A late
      // event can report state, but never undo an unknown result locally.
      if (typeof e.permissionConfigId === "string")
        s.permissionConfigId = e.permissionConfigId;
      if (e.permissionState === "unknown" || e.permissionState === "required") {
        this.permissionRevisions.set(
          key,
          (this.permissionRevisions.get(key) ?? 0) + 1,
        );
        s.permissionState = e.permissionState;
        pauseQueue(s, s.uncertainPrompt ? "uncertain" : "stopped");
      }
    } else if (e.kind === "permissionRequest") {
      applyPermissionRequest(s, {
        requestId: String(e.requestId ?? ""),
        toolCall: e.toolCall,
        options: e.options,
        request: e.request,
      });
    } else if (e.kind === "turnEnd") {
      if (!s.running && !s.uncertainPrompt && !s.connectionOutcomeUnknown)
        return;
      this.stopConfirmation.clear(key);
      if (s.uncertainPrompt) {
        removeQueued(s, s.uncertainPrompt);
        s.uncertainPrompt = null;
      }
      const result = applyTurnEnd(s, {
        stopReason: typeof e.stopReason === "string" ? e.stopReason : undefined,
        error: typeof e.error === "string" ? e.error : undefined,
        failure: e.failure,
      });
      if (e.error === "AUTH_REQUIRED")
        observeAuthentication(
          s.agentId,
          s.cwd,
          e.error,
          s.serviceContext,
          "request",
        );
      else if (
        !e.error &&
        !e.failure &&
        e.stopReason === "end_turn" &&
        (result === "reply" || result === "tool")
      )
        observeAuthentication(
          s.agentId,
          s.cwd,
          undefined,
          s.serviceContext,
          "request",
        );
      this.emit(key);
      this.finishArchiveActivity(s);
      void this.drainQueue(key);
      void this.refreshIndex();
      return;
    } else if (e.kind === "serviceUnavailable") {
      s.sourceError = true;
      s.openError =
        typeof e.message === "string"
          ? e.message
          : STRINGS.repair.requestFailed;
      pauseQueue(s, "unavailable");
    } else if (e.kind === "connectionLost") {
      this.stopConfirmation.clear(key);
      applyConnectionLost(s);
      this.channels.delete(key);
      pauseQueue(s, s.uncertainPrompt ? "uncertain" : "unavailable");
    } else if (e.kind === "interactionsCancelled") {
      clearPendingRequests(s);
    } else if (e.kind === "interactionExpired") {
      expirePendingRequest(s, String(e.requestId ?? ""));
    } else if (e.kind === "elicitationUnavailable") {
      pushRaw(s, e.params, STRINGS.repair.unsupportedInquiry);
      pauseQueue(s, "unavailable");
    } else if (e.kind === "elicitation") {
      applyElicitation(s, e);
    } else if (e.kind === "toolOutput") {
      appendToolOutput(s, e);
    } else if (e.kind === "notification") {
      pushRaw(s, { method: e.method, params: e.params }, "notification");
    } else if (e.update !== undefined) {
      applyUpdate(s, e.update);
      if (live) conversationReadState.receiveUpdate(key, e.update);
      if (
        (e.update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate ===
        "tool_call_update"
      )
        this.finishArchiveActivity(s);
      const update = e.update as {
        sessionUpdate?: unknown;
        content?: { type?: unknown; text?: unknown };
      } | null;
      if (
        [
          "user_message_chunk",
          "agent_message_chunk",
          "agent_thought_chunk",
        ].includes(String(update?.sessionUpdate)) &&
        update?.content?.type === "text" &&
        typeof update.content.text === "string"
      ) {
        this.notifications.schedule(key);
        return;
      }
      if (s.metaDirty) {
        s.metaDirty = false;
        void invoke("session_touch", {
          agentId: s.agentId,
          cwd: s.cwd,
          sessionId: s.nativeSessionId,
          title: s.title,
          configOptions: null,
        })
          .then(() => this.refreshIndex())
          .catch(() => undefined);
      }
    }
    this.emit(key);
  }

  /** Open (or resume) a conversation. Safe to call twice — concurrent
   *  opens for the same target share one request. */
  open(input: OpenInput): Promise<ThreadState> {
    if (input.nativeSessionId) {
      const key = `${input.agentId}:${input.cwd}:${input.nativeSessionId}`;
      const existing = this.threads.get(key);
      if (existing && !existing.openError && !existing.connectionLost) {
        return Promise.resolve(existing);
      }
      if (existing) {
        existing.reconnecting = true;
        this.channels.delete(key);
        this.emit();
      }
    } else if (!input.fresh) {
      const draftKey = this.drafts.get(draftGroup(input));
      const draft = draftKey ? this.threads.get(draftKey) : undefined;
      if (
        draft &&
        draft.identity === "draft" &&
        !draft.openError &&
        !draft.connectionLost
      ) {
        return Promise.resolve(draft);
      }
    }
    const openingKey = `${draftGroup(input)} ${input.nativeSessionId ?? (input.fresh ? "fresh" : "-")}`;
    const pending = this.openings.get(openingKey);
    if (pending) return pending;

    const promise = (async (): Promise<ThreadState> => {
      const channel = new Channel<unknown>();
      const buffered: unknown[] = [];
      const openToken = crypto.randomUUID();
      let replayComplete = false;
      let replayLost = false;
      let replayDelivered: (() => void) | null = null;
      let boundKey: string | null = null;
      channel.onmessage = (event) => {
        const received = event as {
          kind?: unknown;
          openToken?: unknown;
        } | null;
        if (received?.kind === "session_history_complete") {
          if (received.openToken === openToken) {
            replayComplete = true;
            replayDelivered?.();
          }
          return;
        }
        if (boundKey) {
          if (this.channels.get(boundKey) === channel)
            this.applyChannelEvent(boundKey, event);
        } else {
          buffered.push(event);
          if (received?.kind === "connectionLost") {
            replayLost = true;
            replayDelivered?.();
          }
        }
      };
      const result = await invoke<OpenResult>("session_open", {
        agentId: input.agentId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        configOptions: input.configOptions ?? null,
        service: input.service ?? null,
        openToken,
        channel,
      });
      if (result.resumed) {
        // The command response and Channel can be delivered independently.
        // Only this operation's ordered marker proves replay was consumed.
        if (!replayComplete && !replayLost) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            replayDelivered = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        replayDelivered = null;
        const replay = freshThreadState(
          "replay",
          input.agentId,
          result.cwd,
          result.nativeSessionId,
        );
        for (const event of buffered) {
          if (event && typeof event === "object" && "update" in event)
            applyUpdate(replay, event.update);
        }
        const readable = hasReadableMessages(replay.items);
        if (!replayComplete || replayLost || !readable) {
          channel.onmessage = () => {};
          throw new Error(STRINGS.repair.historyUnavailable);
        }
      }
      // The backend returns the canonicalized cwd (/tmp → /private/tmp):
      // the session key must be built from it — the index row the first
      // prompt will create uses the same canonical path.
      const key = `${input.agentId}:${result.cwd}:${result.nativeSessionId}`;
      const canonicalCwd = result.cwd;
      const rows = await invoke<IndexRow[]>("session_index_list").catch(
        () => null,
      );
      if (rows) this.indexRows = rows;
      const existing = this.threads.get(key);
      const state = freshThreadState(
        key,
        input.agentId,
        canonicalCwd,
        result.nativeSessionId,
      );
      state.service = result.service ?? undefined;
      state.serviceContext = result.serviceContext ?? undefined;
      state.draftGroup = draftGroup(input);
      state.resumed = result.resumed;
      state.identity = result.resumed ? "established" : "draft";
      if (existing) {
        state.queued = existing.queued;
        state.queuePaused = existing.queuePaused ?? "unavailable";
        state.uncertainPrompt = existing.uncertainPrompt;
        state.stopUnconfirmed = existing.stopUnconfirmed;
        state.workEnabled = existing.workEnabled;
      } else this.restoreQueue(state);
      // The saved Farfold name is authoritative before replay is delivered.
      // Older rows do not distinguish generated names from explicit renames.
      const savedTitle = this.indexRows.find((row) => row.id === key)?.title;
      state.title = savedTitle?.trim() ? savedTitle : (existing?.title ?? null);
      state.configOptions = normalizeConfigOptions(result.configOptions);
      state.permissionConfigId = result.permissionConfigId;
      state.permissionState = result.permissionConfigId
        ? result.resumed
          ? "required"
          : (result.permissionState ?? "unknown")
        : "ready";
      if (state.permissionConfigId && state.permissionState !== "ready")
        pauseQueue(state, state.uncertainPrompt ? "uncertain" : "stopped");
      // Agents with a top-level `modes` object get a synthetic mode
      // option; it routes to `session/set_mode`, not set_config_option.
      const modeOption = synthesizeModeOption(result.modes);
      if (
        modeOption &&
        !state.configOptions.some((o) => o.category === "mode")
      ) {
        state.modesSeparate = true;
        state.configOptions = [...state.configOptions, modeOption];
        if (typeof modeOption.currentValue === "string")
          state.currentModeId = modeOption.currentValue;
      }
      if (result.configCheck) applyConfigCheck(state, result.configCheck);
      observeAuthentication(
        input.agentId,
        input.cwd,
        undefined,
        state.serviceContext,
      );
      this.threads.set(key, state);
      this.channels.set(key, channel);
      if (!result.resumed) {
        this.drafts.set(draftGroup(input), key);
      }
      boundKey = key;
      for (const event of buffered.splice(0)) {
        this.applyChannelEvent(key, event, false);
      }
      // Replay carries no original timestamps in the supported update shapes.
      // Do not pass the load time off as the time the message was authored.
      if (result.resumed)
        for (const item of state.items) {
          if ("time" in item) item.time = 0;
          if (item.kind === "tool") {
            item.call.startedAt = 0;
            item.call.endedAt = undefined;
          }
        }
      this.emit();
      void this.refreshIndex();
      return state;
    })()
      .catch((error: unknown) => {
        const previous = input.nativeSessionId
          ? this.threads.get(
              `${input.agentId}:${input.cwd}:${input.nativeSessionId}`,
            )
          : undefined;
        if (!input.nativeSessionId || previous)
          observeAuthentication(
            input.agentId,
            input.cwd,
            error,
            previous?.serviceContext ??
              (input.service ? JSON.stringify(input.service) : undefined),
          );
        if (input.nativeSessionId) {
          const key = `${input.agentId}:${input.cwd}:${input.nativeSessionId}`;
          const old =
            this.threads.get(key) ??
            freshThreadState(
              key,
              input.agentId,
              input.cwd,
              input.nativeSessionId,
            );
          if (!this.threads.has(key)) this.restoreQueue(old);
          old.identity = "established";
          old.reconnecting = false;
          // This exact app-owned error comes from the declared load capability.
          // A transport/provider error mentioning recovery is still retryable.
          old.unrecoverable =
            String(error).replace(/^Error:\s*/, "") ===
            STRINGS.thread.notResumable;
          old.openError = old.unrecoverable
            ? STRINGS.thread.notResumable
            : STRINGS.repair.reconnectFailed;
          // Missing history support is not itself a lost connection. If a
          // previous connection was lost, only a successful open can clear it.
          if (!old.unrecoverable) old.connectionLost = true;
          this.threads.set(key, old);
          this.emit();
        }
        throw error;
      })
      .finally(() => {
        this.openings.delete(openingKey);
      });
    this.openings.set(openingKey, promise);
    return promise;
  }

  /** Explicit recovery exit: a separate empty draft, never a resumed prompt. */
  async newAfterRecoveryFailure(key: string): Promise<ThreadState> {
    const old = this.thread(key);
    if (!old || (!old.modelDrift && !old.unrecoverable))
      throw new Error(STRINGS.repair.newDraftFailed);
    return this.open({
      agentId: old.agentId,
      cwd: old.cwd,
      service: old.service,
      fresh: true,
    });
  }

  /** Resume failed state placeholder so the view can explain itself.
   *  `unrecoverable` marks restart-resume failures (PRODUCT.md §7:
   *  「无法恢复」而不是空会话). */
  markOpenFailed(
    key: string,
    agentId: string,
    cwd: string,
    nativeSessionId: string,
    error: string,
    unrecoverable = false,
  ): ThreadState {
    const state =
      this.threads.get(key) ??
      freshThreadState(key, agentId, cwd, nativeSessionId);
    if (!this.threads.has(key)) this.restoreQueue(state);
    state.identity = "established";
    state.openError = error;
    state.unrecoverable = unrecoverable;
    this.threads.set(key, state);
    this.emit();
    return state;
  }

  /** Materialize the index row for an agent-side session (rename / pin /
   *  archive on a `source: "agent"` row) — `session_touch` upserts so the
   *  meta op that follows has a row to mutate. */
  async ensureIndexRow(input: {
    agentId: string;
    cwd: string;
    nativeSessionId: string;
    title?: string | null;
  }): Promise<void> {
    await invoke("session_touch", {
      agentId: input.agentId,
      cwd: input.cwd,
      sessionId: input.nativeSessionId,
      title: input.title ?? null,
      configOptions: null,
    });
    await this.refreshIndex();
  }

  /** Submission acknowledgement, not optimistic rendering, consumes a queued message. */
  async send(key: string, blocks: PromptBlock[]): Promise<SendAdmission> {
    const s = this.thread(key);
    if (!s || !blocks.length)
      return { status: "rejected", reason: "unavailable" };
    if (s.configuring) await this.configRequests.get(key);
    if (s.configError) throw new Error(STRINGS.repair.configFailed);
    // Explicit new input can start after permission/work is restored for an
    // empty queue. Never resume existing or uncertain queued input.
    if (canReleaseEmptyQueuePause(s, blocks)) s.queuePaused = null;
    s.queued.push(blocks);
    this.emit();
    return this.drainQueue(key);
  }

  private async drainQueue(key: string): Promise<SendAdmission> {
    const s = this.thread(key);
    if (
      !s ||
      !canDrain(s) ||
      composerDrafts.read(`queue-edit:${key}`).queueEdit
    )
      return { status: "queued" };
    const blocks = s.queued[0];
    s.submitting = true;
    s.running = true;
    const firstPrompt = s.identity === "draft";
    sealStreams(s);
    const text = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const item: ThreadItem = {
      kind: "user",
      id: nextItemId(),
      text,
      attachments: blocks
        .map(normalizeMessageAttachment)
        .filter((item): item is Attachment => item !== null),
      streaming: false,
      time: Date.now(),
    };
    s.items.push(item);
    s.roundItemBase = s.items.length;
    this.emit();
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
      this.drafts.delete(s.draftGroup ?? "");
      if (firstPrompt && !s.title) {
        s.title = titleFromBlocks(blocks);
        void invoke("session_touch", {
          agentId: s.agentId,
          cwd: s.cwd,
          sessionId: s.nativeSessionId,
          title: s.title,
          configOptions: null,
        })
          .then(() => this.refreshIndex())
          .catch(() => undefined);
      }
    };
    try {
      await validateQueuedAttachments(blocks);
      // Persist the in-flight input before it can reach an Agent. A crash in
      // this window restores an explicitly quarantined request, never a retry.
      this.emit(key);
      await draftPersistence.flush();
      await archiveActivity.begin(key);
      if (
        this.thread(key) !== s ||
        composerDrafts.read(`queue-edit:${key}`).queueEdit ||
        !canDrain({ ...s, running: false, submitting: false })
      ) {
        s.running = false;
        s.items = s.items.filter((i) => i !== item);
        if (s.uncertainPrompt === blocks) s.uncertainPrompt = null;
        if (firstPrompt) s.identity = "draft";
        return { status: "rejected", reason: "unavailable" };
      }
      dispatched = true;
      const result = await invoke<PromptAdmission>("session_prompt", {
        agentId: s.agentId,
        cwd: s.cwd,
        sessionId: s.nativeSessionId,
        content: blocks,
      });
      if (this.thread(key) !== s) return result;
      if (
        result.status === "accepted" ||
        (result.status === "unknown" && receivedEnding())
      ) {
        // The result channel can beat the admission reply. A real ending proves
        // delivery, even if the later admission reply was lost; it proves no success.
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
          s.items = s.items.filter((i) => i !== item);
          pauseQueue(
            s,
            result.reason === "work_disabled"
              ? "work_disabled"
              : result.reason === "failed"
                ? "failed"
                : "unavailable",
          );
        }
      }
      return result;
    } catch (error) {
      if (this.thread(key) !== s) return { status: "unknown" };
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
      s.submitting = false;
      this.emit();
      this.finishArchiveActivity(s);
      // A failed post-admission save must not turn a dispatched message into
      // "unsent". The global save state retains the error for explicit retry.
      await draftPersistence.flush().catch(() => undefined);
      if (canDrain(s)) void this.drainQueue(key);
    }
  }

  async continueQueue(key: string): Promise<void> {
    const s = this.thread(key);
    if (
      !s ||
      s.uncertainPrompt ||
      s.connectionOutcomeUnknown ||
      s.queued.some(queuedAttachmentsNeedReview) ||
      composerDrafts.read(`queue-edit:${key}`).queueEdit ||
      s.configuring ||
      (s.permissionConfigId && s.permissionState !== "ready") ||
      Boolean(s.openError) ||
      s.unrecoverable ||
      s.stopUnconfirmed ||
      s.modelDrift ||
      !s.workEnabled ||
      s.connectionLost
    )
      return;
    s.queuePaused = null;
    this.emit();
    await this.drainQueue(key);
  }

  updateWork(
    cwd: string,
    enabled: Record<string, boolean>,
    locationEnabled?: boolean,
  ): void {
    for (const s of this.threads.values())
      if (s.cwd === cwd) {
        s.workEnabled = locationEnabled ?? enabled[s.agentId] ?? true;
        if (!s.workEnabled) pauseQueue(s, "work_disabled");
      }
    this.emit();
  }

  pauseQueuesForExit(): void {
    for (const s of this.threads.values()) {
      if (s.queued.length)
        pauseQueue(s, s.uncertainPrompt ? "uncertain" : "stopped");
    }
    this.emit();
  }

  beginQueueEdit(key: string, index: number): PromptBlock[] {
    const s = this.thread(key);
    const blocks = s?.queued[index];
    if (
      !s ||
      !blocks ||
      (s.submitting && index === 0) ||
      blocks === s.uncertainPrompt
    )
      throw new Error("这条待发消息暂时无法编辑，请先检查发送结果");
    pauseQueue(s, s.uncertainPrompt ? "uncertain" : "stopped");
    this.emit(key);
    return blocks;
  }

  replaceQueued(
    key: string,
    original: PromptBlock[],
    replacement: PromptBlock[],
  ): void {
    const s = this.thread(key);
    const index = s?.queued.indexOf(original) ?? -1;
    if (
      !s ||
      index < 0 ||
      !replacement.length ||
      (s.submitting && index === 0) ||
      original === s.uncertainPrompt
    )
      throw new Error("这条待发消息暂时无法编辑，请先检查发送结果");
    s.queued[index] = structuredClone(replacement);
    pauseQueue(s, s.uncertainPrompt ? "uncertain" : "stopped");
    this.emit(key);
  }

  dequeue(key: string, index: number): void {
    const s = this.thread(key);
    if (
      !s ||
      (s.submitting && index === 0) ||
      s.queued[index] === s.uncertainPrompt
    )
      return;
    s.queued.splice(index, 1);
    this.emit();
  }

  /** Explicitly abandon only this user-owned retry copy. A hot request's
   * unconfirmed execution remains guarded independently until a real receipt;
   * a successful cold load never invents an outcome for its saved input. */
  abandonUncertainPrompt(
    key: string,
    original: PromptBlock[],
    keep: boolean,
  ): void {
    const s = this.thread(key);
    if (
      !s ||
      s.submitting ||
      s.uncertainPrompt !== original ||
      !s.queued.includes(original)
    )
      throw new Error(STRINGS.repair.uncertainChanged);
    if (keep)
      composerDrafts.update(`session:${key}`, (draft) =>
        keepPromptAsDraft(draft, original),
      );
    removeQueued(s, original);
    s.uncertainPrompt = null;
    pauseQueue(s, s.connectionOutcomeUnknown ? "uncertain" : "stopped");
    s.items.push({
      kind: "notice",
      id: nextItemId(),
      time: Date.now(),
      message: keep
        ? STRINGS.repair.uncertainKept
        : STRINGS.repair.uncertainAbandoned,
    });
    this.emit(key);
  }

  private stopConfirmation = new StopConfirmation();

  async cancel(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (
      !s ||
      (!s.running && !s.connectionOutcomeUnknown) ||
      s.connectionLost ||
      s.stopping
    )
      return;
    pauseQueue(s, "stopped");
    for (const request of s.pendingPermissions)
      if (request.status === "pending") request.decision = null;
    s.stopping = true;
    const isCurrentStop = this.stopConfirmation.start(
      s,
      () => this.threads.get(key),
      () => this.emit(),
    );
    this.emit();
    try {
      await invoke("session_cancel", {
        agentId: s.agentId,
        cwd: s.cwd,
        sessionId: s.nativeSessionId,
      });
    } catch {
      if (
        !isCurrentStop() ||
        this.thread(key) !== s ||
        (!s.running && !s.connectionOutcomeUnknown)
      )
        return;
      this.stopConfirmation.clear(key);
      s.stopping = false;
      s.stopUnconfirmed = true;
      pauseQueue(s, "uncertain");
      this.emit();
    }
    // "停止中…" until turnEnd settles the round — do not flip running here.
  }

  /** Round entry points replace their target; the top-level entry keeps its
   * own manual choice. These references last only as long as the projection. */
  openArtifactPane(key: string, roundId?: string): void {
    const s = this.threads.get(key);
    if (!s) return;
    s.artifactPaneTarget = roundId ? { roundId, selected: null } : null;
    s.artifactPaneOpen = true;
    this.emit();
  }

  selectArtifact(key: string, selected: string, roundId: string | null): void {
    const s = this.threads.get(key);
    if (!s || (s.artifactPaneTarget?.roundId ?? null) !== roundId) return;
    const cards = artifactPaneCards(s, roundId);
    if (
      !cards?.some((card) =>
        card.kind === "diff"
          ? `file:${card.path}` === selected
          : selected === "output",
      )
    )
      return;
    if (s.artifactPaneTarget) s.artifactPaneTarget.selected = selected;
    else s.artifactPaneSelection = selected;
    this.emit();
  }

  closeArtifactPane(key: string): void {
    const s = this.threads.get(key);
    if (!s) return;
    s.artifactPaneOpen = false;
    this.emit();
  }

  /** Answer a pending `elicitation/create` form: `accept` carries the
   *  submitted values, `cancel`/`decline` carry none. */
  respondElicitation(
    key: string,
    requestId: string,
    action: "accept" | "decline" | "cancel",
    values?: Record<string, unknown>,
  ): Promise<void> {
    return this.interactions.respondElicitation(key, requestId, action, values);
  }

  setElicitationValue(
    key: string,
    requestId: string,
    name: string,
    value: unknown,
  ): void {
    const request = this.thread(key)?.pendingElicitations.find(
      (p) => p.requestId === requestId,
    );
    if (!request || request.status !== "pending") return;
    request.values = { ...request.values, [name]: value };
    this.notifications.flush(key);
  }

  async setConfig(
    key: string,
    configId: string,
    value: unknown,
  ): Promise<void> {
    const s = this.thread(key);
    if (!s) return;
    if (
      s.identity === "established" &&
      (modelConfigOption(s.configOptions)?.id === configId ||
        s.configOptions.some(
          (option) =>
            option.id === configId &&
            (option.category === "thought_level" ||
              (!option.category &&
                ["thought_level", "reasoning_effort"].includes(option.id))),
        ))
    )
      throw new Error(STRINGS.repair.modelLocked);
    const permission = s.permissionConfigId === configId;
    const permissionRevision = this.permissionRevisions.get(key) ?? 0;
    if (
      s.submitting ||
      s.configuring ||
      (permission &&
        (s.running ||
          hasActiveTools(s) ||
          s.reconnecting ||
          s.stopping ||
          s.stopUnconfirmed ||
          s.connectionLost ||
          hasPendingRequests(s)))
    )
      throw new Error(STRINGS.repair.configFailed);
    if (permission) {
      s.permissionState = "changing";
      pauseQueue(s, s.uncertainPrompt ? "uncertain" : "stopped");
    }
    s.configuring = true;
    s.configError = null;
    this.emit();
    // A mode synthesized from top-level `modes` goes to set_mode; real
    // configOptions go to set_config_option. The synthesized option must
    // survive a set_config refresh of the option list.
    const synthesizedMode = s.modesSeparate
      ? s.configOptions.find((o) => o.id === "mode")
      : undefined;
    const request = (async () => {
      try {
        if (configId === "mode" && s.modesSeparate) {
          await invoke("session_set_mode", {
            agentId: s.agentId,
            cwd: s.cwd,
            sessionId: s.nativeSessionId,
            modeId: String(value),
          });
          s.currentModeId = String(value);
          for (const option of s.configOptions) {
            if (option.id === "mode") option.currentValue = s.currentModeId;
          }
        } else {
          const updated = await invoke<unknown>("session_set_config", {
            agentId: s.agentId,
            cwd: s.cwd,
            sessionId: s.nativeSessionId,
            configId,
            value,
          });
          const updatedOptions = normalizeConfigOptions(updated);
          if (permission) {
            const actual = updatedOptions.find((o) => o.id === configId);
            if (
              (this.permissionRevisions.get(key) ?? 0) !== permissionRevision ||
              this.thread(key) !== s ||
              s.connectionLost ||
              s.reconnecting ||
              actual?.currentValue !== value
            )
              throw new Error(STRINGS.repair.configFailed);
            s.permissionState = "ready";
          }
          s.configOptions = updatedOptions;
          if (
            synthesizedMode &&
            !s.configOptions.some((o) => o.id === "mode")
          ) {
            s.configOptions = [...s.configOptions, synthesizedMode];
          }
        }
      } catch {
        if (permission) s.permissionState = "unknown";
        s.configError = STRINGS.repair.configFailed;
        throw new Error(s.configError);
      } finally {
        s.configuring = false;
        this.configRequests.delete(key);
        this.emit();
        this.finishArchiveActivity(s);
      }
    })();
    this.configRequests.set(key, request);
    return request;
  }

  async confirmConfig(key: string): Promise<void> {
    const s = this.thread(key);
    if (!s?.configCheck || s.configuring || s.submitting || s.running) return;
    s.configuring = true;
    s.configError = null;
    const displayed = s.configCheck.current;
    this.emit(key);
    try {
      const check = await invoke<ConfigCheck>("session_confirm_config", {
        agentId: s.agentId,
        cwd: s.cwd,
        sessionId: s.nativeSessionId,
        displayed,
      });
      if (this.thread(key) !== s) return;
      // Ordered channel events are authoritative; this reply can arrive after
      // a newer configuration notification and must not overwrite its guard.
      if (check.status !== "ready")
        throw new Error(STRINGS.repair.confirmConfigFailed);
      await this.refreshIndex();
    } catch {
      s.configError = STRINGS.repair.confirmConfigFailed;
    } finally {
      s.configuring = false;
      this.emit(key);
    }
  }

  async reconnect(key: string): Promise<void> {
    const s = this.thread(key);
    if (!s || s.unrecoverable) return;
    try {
      if (s.sourceError) {
        await invoke("session_close", {
          agentId: s.agentId,
          cwd: s.cwd,
          sessionId: s.nativeSessionId,
        });
      }
      await this.open({
        agentId: s.agentId,
        cwd: s.cwd,
        nativeSessionId: s.nativeSessionId,
      });
    } catch {
      /* open preserves the failed state and retry action */
    }
  }

  async close(key: string): Promise<void> {
    this.stopConfirmation.clear(key);
    const s = this.threads.get(key);
    this.channels.delete(key);
    this.threads.delete(key);
    if (s) this.drafts.delete(s.draftGroup ?? "");
    this.emit();
    if (!s) return;
    await invoke("session_close", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
    }).catch(() => undefined);
  }

  // ---- index metadata ops ----

  async rename(rowId: string, title: string): Promise<void> {
    const row = await invoke<IndexRow>("session_meta_rename", {
      sessionId: rowId,
      title,
    });
    const s = this.threads.get(rowId);
    if (s) s.title = row.title;
    this.indexRows = this.indexRows.map((existing) =>
      existing.id === row.id ? row : existing,
    );
    this.emit(rowId);
    await this.refreshIndex();
  }

  async setPinned(rowId: string, pinned: boolean): Promise<void> {
    await invoke("session_meta_pin", { sessionId: rowId, pinned });
    await this.refreshIndex();
  }

  /** The UI and mutation share one guard; this reads existing state only. */
  archiveBlockReason(rowId: string) {
    const state = this.thread(rowId);
    if (state?.stopping) return "stopping" as const;
    if (state?.stopUnconfirmed || state?.uncertainPrompt)
      return "unconfirmed" as const;
    if (state?.submitting) return "submitting" as const;
    if (state?.configuring) return "configuring" as const;
    if (state?.reconnecting) return "reconnecting" as const;
    if (state && this.needsAttention(state)) return "attention" as const;
    if (state && (state.running || hasActiveTools(state)))
      return "running" as const;
    if (state?.queued.length) return "queued" as const;
    if (hasUnsentWork(rowId)) return "unsent" as const;
    return null;
  }

  async setArchived(rowId: string, archived: boolean): Promise<void> {
    if (archived && this.archiveBlockReason(rowId))
      throw new Error(STRINGS.repair.archiveBusy);
    if (!archived) await archiveActivity.touch(rowId);
    await invoke("session_meta_archive", { sessionId: rowId, archived });
    await this.refreshIndex();
  }

  /** Discard an unprompted draft: close the agent session and tombstone it
   *  so `session/list` cannot resurface it as an agent-side row. */
  async discardDraft(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (
      !s ||
      s.identity !== "draft" ||
      s.submitting ||
      s.running ||
      s.queued.length > 0 ||
      s.items.length > 0 ||
      hasPendingRequests(s) ||
      s.uncertainPrompt
    )
      return;
    this.threads.delete(key);
    this.channels.delete(key);
    this.drafts.delete(s.draftGroup ?? "");
    this.emit();
    await invoke("session_close", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
    }).catch(() => undefined);
    await invoke("session_dismiss", {
      agentId: s.agentId,
      cwd: s.cwd,
      nativeSessionId: s.nativeSessionId,
    }).catch(() => undefined);
  }

  /** Delete a session — agent-side `session/delete` when supported, index
   *  row removal, and a tombstone so it cannot reappear. Works for both
   *  meta rows (`source:"meta"`) and agent-side rows (`source:"agent"`). */
  async delete(row: {
    id?: string;
    key?: string;
    agentId: string;
    cwd: string;
    nativeSessionId: string | null;
  }): Promise<void> {
    const native = row.nativeSessionId;
    if (!native) return;
    const key = row.id ?? row.key ?? `${row.agentId}:${row.cwd}:${native}`;
    const s = this.threads.get(key);
    this.threads.delete(key);
    if (s) this.drafts.delete(s.draftGroup ?? "");
    this.channels.delete(key);
    this.emit();
    if (s) {
      await invoke("session_close", {
        agentId: s.agentId,
        cwd: s.cwd,
        sessionId: s.nativeSessionId,
      }).catch(() => undefined);
    }
    await invoke("session_delete", {
      agentId: row.agentId,
      cwd: row.cwd,
      nativeSessionId: native,
    }).catch(() => undefined);
    await this.refreshIndex();
  }
}

export const threads = new ThreadsStore();

// ---------------------------------------------------------------------------
// React bindings
// ---------------------------------------------------------------------------

export function useThreadsSnapshot(): ThreadsSnapshot {
  return useSyncExternalStore(threads.subscribe, threads.getSnapshot);
}

export function useThread(key: string | null | undefined): ThreadState | null {
  const subscribe = useCallback(
    (fn: () => void) => (key ? threads.subscribeThread(key, fn) : () => {}),
    [key],
  );
  const getVersion = useCallback(
    () => (key ? threads.threadVersion(key) : 0),
    [key],
  );
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return key ? (threads.thread(key) ?? null) : null;
}

// Re-exported for existing `../runtime/sessions` imports; the sidebar
// view-model helpers now live in `runtime/sidebar.ts`.
export { basename, groupSidebarRows, relativeTime, shortPath } from "./sidebar";
export type { SidebarRow } from "./sidebar";
