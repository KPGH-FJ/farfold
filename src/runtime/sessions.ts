import { openingInquiries } from "./opening_inquiries";
import { draftGroup, type OpenInput } from "./session_open_input";
export type { OpenInput } from "./session_open_input";
import { observeAuthentication } from "./authentication";
import {
  discardEmptyDraft,
  retirePreparationRead,
} from "./session_draft_cleanup";
import {
  applyConfigCheck,
  releaseConfigurationPause,
  sameConfigurationSnapshot,
  type ConfigCheck,
} from "./config_check";
import {
  ConfigurationRecheck,
  recheckConfiguration,
  hasConfigurationRecheckRecovery,
} from "./session_config_recheck";
import { SessionConfiguration } from "./session_configuration";
import { configChangeBusy } from "./protected_config";
import { retainReportedDetails } from "./reported_details";
import { receiveAsyncTasks, type AsyncTask } from "./async_tasks";
import { stopAsyncTask } from "./async_task_actions";
/**
 * Session command client and normalized conversation state.
 * Agent updates enter the shared `applyUpdate` projection.
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
import {
  observeDesktopNotification,
  beginSuccessDesktopNotification,
  checkDesktopNotifications,
} from "./desktop_notifications";
import { paneCards, appendToolOutput } from "./artifacts";
import { artifactPaneCards } from "./artifact_view";
import type { PaneCard } from "./artifacts";
import { STRINGS } from "./strings";
import { InteractionActions } from "./interaction_actions";
import { StopConfirmation } from "./stop_confirmation";
import { composerDrafts, draftQueues, draftPersistence } from "./drafts";
import { normalizeMessageAttachments } from "./message_attachments";
import { validateQueuedAttachments } from "./draft_attachments";
import {
  markRestoredQueueAttachments,
  queuedAttachmentsNeedReview,
} from "./recovered_attachments";
import { keepPromptAsDraft } from "./uncertain_prompt";
import { archiveActivity } from "./archive_activity";
import { archiveBlockReason, archiveIndexRow } from "./archive_admission";
import { LIBRARY } from "./library_strings";
import { settledRoundResults } from "./round_result";
import { uiError } from "./ui_error";
import { HistoryReplayBuffer, finishHistoryPrefix } from "./history_replay";
import {
  requireReadableHistory,
  isHistoryReadFailure,
  historyFailureKey,
  recoveryTarget,
  retainRecoveryFailure,
  recoveryDraftService,
  closeRecoveryRoute,
  needsCanonicalRecovery,
  canonicalRecoveryOpen,
} from "./session_recovery";
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

import type { OpenResult } from "./session_open_types";
export type { OpenResult } from "./session_open_types";

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
import type { PromptBlock, ThreadItem, ThreadState } from "./session_types";
import { hasActiveTools, hasPendingRequests } from "./session_types";
export * from "./session_types";
export {
  freshThreadState,
  applyElicitation,
  completeElicitation,
  applyUpdate,
  applyTurnEnd,
  applyConnectionLost,
  normalizeConfigOptions,
  replaceConfigOptions,
  modelConfigOption,
  modelValueOf,
  storedModelValue,
  configValueLabel,
  synthesizeModeOption,
} from "./session_projection";
import {
  freshThreadState,
  applyElicitation,
  completeElicitation,
  clearPendingRequests,
  expirePendingRequest,
  applyUpdate,
  applyTurnEnd,
  applyConnectionLost,
  normalizeConfigOptions,
  replaceConfigOptions,
  modelConfigOption,
  modelValueOf,
  synthesizeModeOption,
  applyPermissionRequest,
  nextItemId,
  sealStreams,
  pushRaw,
  pushNotification,
  isKnownConfigUpdate,
} from "./session_projection";
import { ThreadNotifications } from "./thread_notifications";
import { conversationReadState } from "./conversation_read_state";
import { observeBrowserRequests } from "./session_browser_attention";

export interface ThreadsSnapshot {
  version: number;
  threads: Map<string, ThreadState>;
  index: IndexRow[];
  /** `settings.autoArchiveDays` (0 = off). */
  autoArchiveDays: number;
}

/** Default auto-archive window when the setting is unset (days). */
export const DEFAULT_AUTO_ARCHIVE_DAYS = 30;

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
  constructor() {
    observeBrowserRequests(
      (key) => this.thread(key),
      (key) => this.emit(key, true),
    );
  }
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
  private configurations = new SessionConfiguration({
    thread: (key) => this.thread(key),
    emit: () => this.emit(),
    finish: (thread) => this.finishArchiveActivity(thread),
    permissionRevision: (key) => this.permissionRevisions.get(key) ?? 0,
  });
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

  private emit(key?: string, preserveQueues = false): void {
    checkDesktopNotifications();
    for (const state of preserveQueues
      ? []
      : key
        ? [this.thread(key)]
        : this.threads.values()) {
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
    checkDesktopNotifications(s);
    if (
      this.thread(s.key) !== s ||
      s.running ||
      s.submitting ||
      s.stopping ||
      s.stopUnconfirmed ||
      s.connectionLost ||
      s.connectionOutcomeUnknown ||
      s.uncertainPrompt ||
      hasActiveTools(s) ||
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
    observeDesktopNotification(s, e, live, () => this.thread(key) === s);
    if (e.kind === "configOptions") {
      if (!this.configurations.changing(s))
        replaceConfigOptions(
          s,
          normalizeConfigOptions(e.options),
          e.modern !== false,
        );
    } else if (e.kind === "configCheck") {
      if (!this.configurations.receiveCheck(s, e.check as ConfigCheck))
        applyConfigCheck(s, e.check as ConfigCheck);
    } else if (e.kind === "asyncTasks") {
      if (!receiveAsyncTasks(s, e)) return;
      this.finishArchiveActivity(s);
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
        usage: e.usage,
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
      applyConnectionLost(s, e.closeReason);
      this.channels.delete(key);
      pauseQueue(s, s.uncertainPrompt ? "uncertain" : "unavailable");
    } else if (e.kind === "interactionsCancelled") {
      clearPendingRequests(s);
    } else if (e.kind === "interactionExpired") {
      expirePendingRequest(s, String(e.requestId ?? ""));
    } else if (e.kind === "elicitationUnavailable") {
      pushRaw(s, e.params, STRINGS.repair.unsupportedInquiry);
      pauseQueue(s, "unavailable");
    } else if (e.kind === "elicitationComplete") {
      completeElicitation(s, e);
    } else if (e.kind === "elicitation") {
      applyElicitation(s, e);
    } else if (e.kind === "toolOutput") {
      appendToolOutput(s, e);
    } else if (e.kind === "notification") {
      pushNotification(s, { method: e.method, params: e.params });
    } else if (e.update !== undefined) {
      if (
        (e.update as { sessionUpdate?: unknown } | null)?.sessionUpdate ===
        "config_option_update"
      ) {
        if (!isKnownConfigUpdate(e.update))
          pushRaw(s, e.update, "config_option_update");
        retainReportedDetails(s, e.update, e);
        this.emit(key);
        return;
      }
      applyUpdate(s, e.update, e);
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

  /** Concurrent opens for the same target share one close/load request. */
  open(input: OpenInput): Promise<ThreadState> {
    if (needsCanonicalRecovery(input, this.threads))
      return canonicalRecoveryOpen(
        input,
        this.threads,
        (canonical) => this.openTarget(canonical),
        this.markOpenFailed.bind(this),
      );
    return this.openTarget(input);
  }

  private openTarget(
    input: OpenInput,
    recheck?: ConfigurationRecheck,
  ): Promise<ThreadState> {
    let retryState: ThreadState | undefined;
    if (input.nativeSessionId) {
      const key = `${input.agentId}:${input.cwd}:${input.nativeSessionId}`;
      const existing = this.threads.get(key);
      if (
        existing &&
        !recheck &&
        !existing.openError &&
        !existing.connectionLost
      ) {
        return Promise.resolve(existing);
      }
      if (existing) {
        retryState = existing;
        existing.reconnecting = true;
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
    if (pending) {
      openingInquiries.join(
        openingKey,
        input.inquiryCurrent,
        input.inquirySignal,
      );
      return pending;
    }
    const inquiry = openingInquiries.begin(openingKey, input);

    let opened: OpenResult | undefined;
    let routePrepared = false;
    let abandonRecheck: (() => void) | undefined;
    const promise = (async (): Promise<ThreadState> => {
      if (recheck) await recheck.detach();
      else if (retryState?.historyUnavailable || retryState?.sourceError)
        await closeRecoveryRoute(retryState);
      if (retryState && this.thread(retryState.key) !== retryState)
        throw new Error(STRINGS.repair.reconnectFailed);
      routePrepared = true;
      if (retryState) this.channels.delete(retryState.key);
      const channel = new Channel<unknown>();
      const buffered = new HistoryReplayBuffer();
      const openToken = crypto.randomUUID();
      let replayComplete = false;
      let replayLost = false;
      let replayDelivered: (() => void) | null = null;
      let boundKey: string | null = null;
      let historyFailed = false;
      let recheckObserver = recheck;
      if (recheck)
        abandonRecheck = () => {
          channel.onmessage = () => {};
          recheckObserver = undefined;
        };
      channel.onmessage = (event) => {
        if (!boundKey && inquiry.receive(event)) return;
        recheckObserver?.observe(event);
        const received = event as {
          kind?: unknown;
          openToken?: unknown;
        } | null;
        if (received?.kind === "session_history_complete") {
          if (received.openToken === openToken) {
            buffered.mark(openToken);
            replayComplete = true;
            replayDelivered?.();
          }
          return;
        }
        if (boundKey) {
          if (
            this.channels.get(boundKey) === channel &&
            (!historyFailed || received?.kind === "connectionLost")
          )
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
        service: input.service
          ? {
              ...input.service,
              revision:
                input.serviceRevision ??
                (input.service as { revision?: string }).revision,
            }
          : null,
        openToken,
        channel,
      });
      opened = result;
      recheck?.validateResult(result);
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
        try {
          requireReadableHistory(
            input.agentId,
            result,
            buffered.prefix(openToken),
            replayComplete,
            replayLost,
          );
        } catch (error) {
          buffered.clear();
          if (isHistoryReadFailure(error)) {
            // Retain only actual loss from this owner, never late replay content.
            historyFailed = true;
            boundKey = recoveryTarget(input, result).key;
            this.channels.set(boundKey, channel);
          } else channel.onmessage = () => {};
          throw error;
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
      recheck?.validateResult(result);
      const existing = this.threads.get(key);
      const state = freshThreadState(
        key,
        input.agentId,
        canonicalCwd,
        result.nativeSessionId,
      );
      state.service = result.service ?? undefined;
      state.serviceContext = result.serviceContext ?? undefined;
      state.connectionId = result.connectionId;
      state.draftGroup = draftGroup(input);
      state.resumed = result.resumed;
      state.identity = result.resumed ? "established" : "draft";
      if (existing) {
        state.queued = existing.queued;
        state.queuePaused = existing.queuePaused ?? "unavailable";
        state.uncertainPrompt = existing.uncertainPrompt;
        state.stopUnconfirmed = existing.stopUnconfirmed;
        state.connectionOutcomeUnknown = existing.connectionOutcomeUnknown;
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
      // Prefer the Agent's actual modern declaration, not synthesized model options.
      const modeOption = synthesizeModeOption(
        result.modes,
        result.configOptionsModern ?? Array.isArray(result.configOptions),
      );
      if (
        modeOption &&
        !state.configOptions.some(
          (o) => o.id === "mode" || o.category === "mode",
        )
      ) {
        state.modesSeparate = true;
        state.configOptions = [...state.configOptions, modeOption];
        if (typeof modeOption.currentValue === "string")
          state.currentModeId = modeOption.currentValue;
      }
      if (result.configCheck) applyConfigCheck(state, result.configCheck);
      if (result.warnings?.length && result.configCheck?.status !== "ready")
        state.configError = STRINGS.repair.recheckConfigFailed;
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
      const { prefix, following } = buffered.take(
        result.resumed ? openToken : undefined,
      );
      for (const event of prefix) {
        this.applyChannelEvent(key, event, false);
      }
      if (result.resumed) finishHistoryPrefix(state);
      for (const event of following) this.applyChannelEvent(key, event);
      recheck?.finish(state, result);
      recheckObserver = undefined;
      this.emit();
      void this.refreshIndex();
      return state;
    })()
      .catch((error: unknown) => {
        inquiry.finish(true);
        if (recheck && this.thread(recheck.original.key) !== recheck.original) {
          abandonRecheck?.();
          throw error;
        }
        if (!routePrepared && retryState) {
          retryState.reconnecting = false;
          this.emit();
          throw error;
        }
        const target = recoveryTarget(input, opened);
        const previous = input.nativeSessionId
          ? (this.threads.get(target.key) ??
            this.threads.get(target.originalKey))
          : undefined;
        if (!input.nativeSessionId || previous)
          observeAuthentication(
            input.agentId,
            target.cwd,
            error,
            previous?.serviceContext ??
              (input.service ? JSON.stringify(input.service) : undefined),
          );
        if (input.nativeSessionId) {
          const key = target.key;
          const old =
            previous ??
            freshThreadState(
              key,
              input.agentId,
              target.cwd,
              input.nativeSessionId,
            );
          if (!previous) this.restoreQueue(old);
          if (old.key !== key) {
            this.threads.delete(old.key);
            this.channels.delete(old.key);
            old.key = key;
            old.cwd = target.cwd;
          }
          retainRecoveryFailure(old, error, recheck ? undefined : opened);
          this.threads.set(key, old);
          this.emit();
        }
        throw error;
      })
      .finally(() => {
        inquiry.finish();
        this.openings.delete(openingKey);
      });
    this.openings.set(openingKey, promise);
    return promise;
  }

  /** Explicit recovery exit: a separate empty draft, never a resumed prompt. */
  async newAfterRecoveryFailure(key: string): Promise<ThreadState> {
    const old = this.thread(key);
    if (
      !old ||
      (!old.modelDrift && !old.unrecoverable && !old.historyUnavailable)
    )
      throw new Error(STRINGS.repair.newDraftFailed);
    return this.open({
      agentId: old.agentId,
      cwd: old.cwd,
      service: recoveryDraftService(old),
      fresh: true,
    });
  }

  /** Preserve failed state; restart-resume failures render as 无法恢复. */
  markOpenFailed(
    key: string,
    agentId: string,
    cwd: string,
    nativeSessionId: string,
    error: string,
    unrecoverable = false,
    preserveQueues = false,
  ): ThreadState {
    const state =
      this.threads.get(key) ??
      freshThreadState(key, agentId, cwd, nativeSessionId);
    if (!this.threads.has(key)) this.restoreQueue(state);
    state.identity = "established";
    state.openError = error;
    state.unrecoverable = unrecoverable;
    this.threads.set(key, state);
    this.emit(undefined, preserveQueues);
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
    if (s.configuring) await this.configurations.requests.get(key);
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
    const finishPreparation = this.stopConfirmation.prepare(s);
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
      attachments: [],
      streaming: false,
      time: Date.now(),
    };
    s.items.push(item);
    s.roundItemBase = s.items.length;
    beginSuccessDesktopNotification(s, () => this.thread(key) === s);
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
      // Project checked dispatch content, not the earlier queue snapshot.
      item.attachments = normalizeMessageAttachments(blocks);
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
      finishPreparation();
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
          // Rejected admission proves this prompt never began; no completion
          // can arrive to settle a stop requested while its reply was pending.
          this.stopConfirmation.clear(key);
          s.stopping = false;
          s.stopUnconfirmed = false;
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
      finishPreparation();
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
      throw new Error(STRINGS.repair.queuedEditBlocked);
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
      throw new Error(STRINGS.repair.queuedEditBlocked);
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

  async stopTask(key: string, task: AsyncTask): Promise<void> {
    const thread = this.thread(key);
    if (thread)
      await stopAsyncTask(
        thread,
        task,
        () => this.thread(key),
        () => this.emit(),
      );
  }

  async cancel(key: string): Promise<void> {
    return this.stopConfirmation.cancel(
      this.thread(key),
      () => this.threads.get(key),
      () => this.emit(),
    );
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
    return this.configurations.set(key, configId, value);
  }

  async confirmConfig(key: string): Promise<void> {
    const s = this.thread(key);
    if (!s?.configCheck || configChangeBusy(s)) return;
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
      if (
        s.configCheck?.status === "ready" &&
        sameConfigurationSnapshot(s.configCheck.current, check.current)
      )
        releaseConfigurationPause(s);
      await this.refreshIndex();
    } catch {
      s.configError = STRINGS.repair.confirmConfigFailed;
    } finally {
      s.configuring = false;
      this.emit(key);
    }
  }

  recheckConfig(key: string): Promise<ThreadState> {
    return recheckConfiguration(
      this.thread(key),
      () => this.thread(key),
      () => this.permissionRevisions.get(key) ?? 0,
      (input, owner) => this.openTarget(input, owner),
      () => this.emit(key),
    );
  }

  async reconnect(key: string): Promise<ThreadState | undefined> {
    const s = this.thread(key);
    if (!s || s.unrecoverable) return;
    try {
      if (hasConfigurationRecheckRecovery(s))
        return await this.recheckConfig(key);
      return await this.open({
        agentId: s.agentId,
        cwd: s.cwd,
        nativeSessionId: s.nativeSessionId,
      });
    } catch (error) {
      const failedKey = historyFailureKey(error);
      return failedKey ? this.thread(failedKey) : undefined;
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
    return archiveBlockReason(rowId, this.thread(rowId), (state) =>
      this.needsAttention(state),
    );
  }

  async setArchived(rowId: string, archived: boolean): Promise<void> {
    await archiveIndexRow(
      rowId,
      archived,
      this.indexRows.find((row) => row.id === rowId),
      (key) => this.archiveBlockReason(key),
    );
    await this.refreshIndex();
  }

  /** Discard an unprompted draft: close the agent session and tombstone it
   *  so `session/list` cannot resurface it as an agent-side row. */
  async discardDraft(key: string, strict = false): Promise<void> {
    await discardEmptyDraft(
      this.threads.get(key),
      (s) => {
        if (this.threads.get(key) !== s) return;
        this.threads.delete(key);
        this.channels.delete(key);
        if (this.drafts.get(s.draftGroup ?? "") === key)
          this.drafts.delete(s.draftGroup ?? "");
        this.emit();
      },
      strict,
    );
  }

  async retirePreparationDraft(
    key: string,
    owns: () => boolean,
  ): Promise<void> {
    await retirePreparationRead(this.threads.get(key), owns, (s, retain) => {
      if (retain) applyConnectionLost(s);
      else {
        this.threads.delete(key);
        this.channels.delete(key);
      }
      if (this.drafts.get(s.draftGroup ?? "") === key)
        this.drafts.delete(s.draftGroup ?? "");
      this.emit(key);
    });
  }

  /** Delete a session — agent-side `session/delete` when supported, index
   *  row removal, and a tombstone so it cannot reappear. Works for both
   *  meta rows (`source:"meta"`) and agent-side rows (`source:"agent"`).
   *  Reports the agent-side outcome: "deleted" (the agent confirmed),
   *  "unsupported" (it cannot delete or could not be asked — its record
   *  stays), "unconfirmed" (the request failed, residue unknown). */
  async delete(row: {
    id?: string;
    key?: string;
    agentId: string;
    cwd: string;
    nativeSessionId: string | null;
  }): Promise<"deleted" | "unsupported" | "unconfirmed"> {
    const native = row.nativeSessionId;
    if (!native) return "unsupported";
    const key = row.id ?? row.key ?? `${row.agentId}:${row.cwd}:${native}`;
    // W3-9：进行中、发送中、停止/结果未确认或还有未发送内容的对话不能
    // 删除——先完成或清除，避免索引与 Agent 侧活动工作失联。
    const blocked = this.archiveBlockReason(key);
    if (blocked) throw new Error(LIBRARY.deleteReasons[blocked]);
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
    const remote = await invoke<"deleted" | "unsupported" | "unconfirmed">(
      "session_delete",
      {
        agentId: row.agentId,
        cwd: row.cwd,
        nativeSessionId: native,
      },
    ).catch((): "unconfirmed" => "unconfirmed");
    await this.refreshIndex();
    return remote;
  }
}

export const threads = new ThreadsStore();

// React bindings live in `session_hooks.ts`; re-exported for existing
// `../runtime/sessions` imports.
export { useThread, useThreadsSnapshot } from "./session_hooks";

// Re-exported for existing `../runtime/sessions` imports; the sidebar
// view-model helpers now live in `runtime/sidebar.ts`.
export { basename, groupSidebarRows, relativeTime, shortPath } from "./sidebar";
export type { SidebarRow } from "./sidebar";
