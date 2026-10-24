import {
  applySessionEvent,
  flushSessionMetadata,
} from "./session_event_projection";
import { SessionDeliveryObserver } from "./session_delivery_observer";
import { OwnedSessionChannel, SessionChannels } from "./session_channels";
import { openDeliveryConsumer } from "./session_open_delivery";
import { openingInquiries } from "./opening_inquiries";
import { drainPrompt } from "./session_prompt_dispatch";
import { PromptRequestOwner } from "./prompt_admission";
import { ProcessEndedChannel } from "./session_process_ended";
import { retainIndexRows } from "./session_index_refresh";
import { draftGroup, type OpenInput } from "./session_open_input";
export type { OpenInput } from "./session_open_input";
import { observeAuthentication } from "./authentication";
import {
  discardEmptyDraft,
  retirePreparationRead,
} from "./session_draft_cleanup";
import {
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
import { confirmSavedConfiguration } from "./saved_configuration_restore";
import { configChangeBusy } from "./protected_config";
import type { AsyncTask } from "./async_tasks";
import { stopAsyncTask } from "./async_task_actions";
import { hasActiveCompaction } from "./compaction_activity";
import { hasActiveFork } from "./session_fork_activity";
import { SessionForks } from "./session_fork";
import { threadNeedsAttention } from "./thread_attention";
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
import { checkDesktopNotifications } from "./desktop_notifications";
import { paneCards } from "./artifacts";
import { artifactPaneCards } from "./artifact_view";
import type { PaneCard } from "./artifacts";
import { STRINGS } from "./strings";
import { InteractionActions } from "./interaction_actions";
import { StopConfirmation } from "./stop_confirmation";
import { composerDrafts, draftQueues, draftPersistence } from "./drafts";
import {
  markRestoredQueueAttachments,
  queuedAttachmentsNeedReview,
} from "./recovered_attachments";
import { keepPromptAsDraft } from "./uncertain_prompt";
import { archiveActivity } from "./archive_activity";
import { archiveBlockReason, archiveIndexRow } from "./archive_admission";
import { LIBRARY } from "./library_strings";
import { settledRoundResults } from "./round_result";
import {
  SessionOpenReplay,
  applyFailedHistoryEvent,
} from "./session_open_replay";
import { historyReads } from "./session_history_admission";
import {
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
import {
  hasActiveTools,
  hasPendingRequests,
  hasUnconfirmedHistoryTools,
} from "./session_types";
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
  applyConnectionLost,
  nextItemId,
} from "./session_projection";
import { ThreadNotifications } from "./thread_notifications";
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
  private channels = new SessionChannels();
  private permissionRevisions = new Map<string, number>();
  private forks = new SessionForks({
    thread: (key) => this.thread(key),
    rows: () => this.indexRows,
    install: (state, channel, permissionChanges) => {
      this.threads.set(state.key, state);
      this.channels.set(state.key, channel);
      this.recordPermissionChanges(state.key, permissionChanges);
      flushSessionMetadata(state, () => {
        void this.refreshIndex();
      });
    },
    ownsChannel: (key, channel) => this.channels.get(key) === channel,
    apply: (key, event, live) => this.applyChannelEvent(key, event, live),
    emit: (key) => this.emit(key),
    refreshIndex: () => this.refreshIndex(),
  });
  forkCurrent(key: string): Promise<ThreadState | undefined> {
    return this.forks.start(key);
  }
  prepareNewFork(key: string, operationId: string): boolean {
    return this.forks.prepareNew(key, operationId);
  }
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
        Boolean(
          state.historicalOutcomeUnknown ||
          state.connectionOutcomeUnknown ||
          state.stopUnconfirmed,
        ),
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
      hasUnconfirmedHistoryTools(s) ||
      hasActiveCompaction(s) ||
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
    state.historicalOutcomeUnknown = saved.outcomeUnknown === true;
    state.queued = saved.blocks;
    markRestoredQueueAttachments(state.queued);
    state.uncertainPrompt =
      saved.uncertainIndex === null
        ? null
        : (saved.blocks[saved.uncertainIndex] ?? null);
    if (saved.blocks.length)
      state.queuePaused = state.uncertainPrompt ? "uncertain" : "stopped";
  }

  needsAttention(s: ThreadState): boolean {
    return threadNeedsAttention(s);
  }

  /** Dismiss only the historical notice on this exact currently shown view. */
  acknowledgeHistoricalOutcome(state: ThreadState): void {
    if (this.thread(state.key) !== state || !state.historicalOutcomeUnknown)
      return;
    state.historicalOutcomeUnknown = false;
    this.emit(state.key);
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
      const rows = await invoke<IndexRow[]>("session_index_list");
      this.indexRows = retainIndexRows(this.indexRows, rows);
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

  private recordPermissionChanges(key: string, count = 1): void {
    if (count > 0)
      this.permissionRevisions.set(
        key,
        (this.permissionRevisions.get(key) ?? 0) + count,
      );
  }

  private applyChannelEvent(
    key: string,
    event: unknown,
    live = true,
    activityConnectionId?: string,
  ): void {
    const state = this.threads.get(key);
    if (!state) return;
    applySessionEvent(
      state,
      event,
      live,
      {
        owns: () => this.thread(key) === state,
        promptOwner: () => this.promptOwners.get(state),
        configurationChanging: () => this.configurations.changing(state),
        receiveConfigCheck: (check) =>
          this.configurations.receiveCheck(state, check),
        finishActivity: () => this.finishArchiveActivity(state),
        permissionChanged: () => this.recordPermissionChanges(key),
        clearStop: () => this.stopConfirmation.clear(key),
        closeChannel: () => {
          this.channels.delete(key);
        },
        emit: () => this.emit(key),
        drain: () => {
          void this.drainQueue(key);
        },
        refresh: () => {
          void this.refreshIndex();
        },
        schedule: () => this.notifications.schedule(key),
      },
      activityConnectionId,
    );
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
      if (existing && hasActiveFork(existing))
        return Promise.reject(new Error(STRINGS.repair.reconnectFailed));
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
      historyReads.join(openingKey, input);
      openingInquiries.join(
        openingKey,
        input.inquiryCurrent,
        input.inquirySignal,
      );
      return pending;
    }
    const inquiry = openingInquiries.begin(openingKey, input);
    const replay = new SessionOpenReplay(
      input,
      (key) => this.threads.get(key),
      (state) => this.restoreQueue(state),
      undefined,
      () => !retryState || this.thread(retryState.key) === retryState,
    );
    let resumeDelivery: (() => void) | undefined;
    const delivery = new SessionDeliveryObserver(input.agentId, replay.token);
    const channel = new OwnedSessionChannel(delivery);
    let deliveryBound = false;
    const admission = historyReads.begin(openingKey, input, replay.token);

    let opened: OpenResult | undefined;
    let routePrepared = false;
    let abandonRecheck: (() => void) | undefined;
    let receivingReplay = true;
    let bindFailedReplay: ((state: ThreadState) => void) | undefined;
    const promise = (async (): Promise<ThreadState> => {
      if (recheck) await recheck.detach();
      else if (retryState?.historyUnavailable || retryState?.sourceError)
        await closeRecoveryRoute(retryState);
      if (retryState && this.thread(retryState.key) !== retryState)
        throw new Error(STRINGS.repair.reconnectFailed);
      routePrepared = true;
      if (retryState) this.channels.delete(retryState.key);
      const openToken = replay.token;
      let boundKey: string | null = null;
      const processEndedChannel = new ProcessEndedChannel(
        (key) => this.thread(key),
        (key, event) => this.applyChannelEvent(key, event),
      );
      let historyFailed = false;
      let failedLive = false;
      let failedConnectionId: string | undefined;
      const applyFailedLive = (state: ThreadState, event: unknown) =>
        applyFailedHistoryEvent(
          state,
          event,
          (value) =>
            this.applyChannelEvent(
              state.key,
              value,
              true,
              failedLive ? failedConnectionId : undefined,
            ),
          () => this.emit(state.key),
        );
      let recheckObserver = recheck;
      if (recheck)
        abandonRecheck = () => {
          channel.dispose();
          recheckObserver = undefined;
        };
      channel.onmessage = openDeliveryConsumer(delivery, {
        key: () => boundKey,
        owns: (key) => this.channels.get(key) === channel,
        thread: (key) => this.thread(key),
        inquiry: (event) => inquiry.receive(event),
        recheck: (event) => recheckObserver?.observe(event),
        marker: (event) => {
          if (!replay.receiveMarker(event)) return false;
          resumeDelivery ??= delivery.pause();
          return true;
        },
        historyFailed: () => historyFailed,
        failedLive: () => failedLive,
        applyFailed: applyFailedLive,
        apply: (key, event) => this.applyChannelEvent(key, event),
        receiving: () => receivingReplay,
        project: (event) => {
          admission?.observeRaw();
          return replay.push(event);
        },
      });
      admission?.dispatch();
      const result = await invoke<OpenResult>("session_open", {
        processEndedChannel,
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
        admissionChannel: admission?.channel ?? new Channel<unknown>(),
        channel,
      });
      opened = result;
      recheck?.validateResult(result);
      // The hidden state receives the prefix once; its marker is acknowledged
      // before pull pauses. The command can return without any further body.
      await replay.waitForReady(result.resumed);
      const key = `${input.agentId}:${result.cwd}:${result.nativeSessionId}`;
      const rows = await invoke<IndexRow[]>("session_index_list").catch(
        () => null,
      );
      if (rows) this.indexRows = retainIndexRows(this.indexRows, rows);
      recheck?.validateResult(result);
      let state: ThreadState;
      try {
        state = replay.accept(
          result,
          this.indexRows.find((row) => row.id === key)?.title,
          this.threads.get(key),
        );
      } catch (error) {
        if (isHistoryReadFailure(error)) {
          historyFailed = true;
          const id = result.connectionId;
          failedConnectionId =
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= 4096 &&
            !id.includes("\0")
              ? id
              : undefined;
          failedLive =
            replay.acknowledgedPrefix && failedConnectionId !== undefined;
          // Following bodies remain in the same native budgeted queue until
          // this exact old view is installed. No failed-history copy is retained.
          bindFailedReplay = (old) => {
            boundKey = old.key;
            if (failedConnectionId) old.connectionId = failedConnectionId;
            this.channels.set(boundKey, channel);
            deliveryBound = true;
            processEndedChannel.bind(old);
          };
        } else channel.dispose();
        throw error;
      }
      observeAuthentication(
        input.agentId,
        input.cwd,
        undefined,
        state.serviceContext,
      );
      const previous = this.threads.get(key);
      if (previous) this.forks.retire(previous);
      this.stopConfirmation.clear(key);
      this.threads.set(key, state);
      this.channels.set(key, channel);
      this.recordPermissionChanges(key, replay.acceptedPermissionChanges);
      if (!result.resumed) {
        this.drafts.set(draftGroup(input), key);
      }
      boundKey = key;
      deliveryBound = true;
      inquiry.handoffPermissions(
        state,
        () => this.thread(key) === state && this.channels.get(key) === channel,
        () => this.emit(key),
      );
      processEndedChannel.bind(state);
      recheck?.finish(state, result);
      recheckObserver = undefined;
      flushSessionMetadata(state, () => {
        void this.refreshIndex();
      });
      this.emit();
      void this.refreshIndex();
      return state;
    })()
      .catch((error: unknown) => {
        inquiry.finish(true);
        if (
          (recheck && this.thread(recheck.original.key) !== recheck.original) ||
          (retryState && this.thread(retryState.key) !== retryState)
        ) {
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
            const revision = this.removeThread(old.key);
            if (revision)
              this.permissionRevisions.set(
                key,
                Math.max(revision, this.permissionRevisions.get(key) ?? 0),
              );
            this.channels.delete(old.key);
            old.key = key;
            old.cwd = target.cwd;
          }
          retainRecoveryFailure(old, error, recheck ? undefined : opened);
          this.threads.set(key, old);
          bindFailedReplay?.(old);
          this.emit();
        }
        throw error;
      })
      .finally(() => {
        receivingReplay = false;
        delivery.discardBuffered();
        if (!deliveryBound) channel.dispose();
        replay.clear();
        resumeDelivery?.();
        resumeDelivery = undefined;
        historyReads.finish(openingKey, admission);
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

  private drainQueue(key: string): Promise<SendAdmission> {
    return drainPrompt(key, {
      thread: (key) => this.thread(key),
      emit: (key) => this.emit(key),
      stop: this.stopConfirmation,
      owners: this.promptOwners,
      retireDraft: (state) => {
        this.drafts.delete(state.draftGroup ?? "");
      },
      refreshIndex: () => this.refreshIndex(),
      finishArchive: (state) => this.finishArchiveActivity(state),
      drain: (key) => this.drainQueue(key),
    });
  }

  async continueQueue(key: string): Promise<void> {
    const s = this.thread(key);
    if (
      !s ||
      s.uncertainPrompt ||
      s.connectionOutcomeUnknown ||
      s.queued.some(queuedAttachmentsNeedReview) ||
      hasActiveCompaction(s) ||
      hasActiveFork(s) ||
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
  private promptOwners = new WeakMap<ThreadState, PromptRequestOwner>();

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
    const thread = this.thread(key);
    const owner = thread && this.promptOwners.get(thread);
    if (owner && !owner.isOffered()) {
      await owner.cancel();
      return;
    }
    return this.stopConfirmation.cancel(
      thread,
      () => this.threads.get(key),
      () => this.emit(),
      owner
        ? async () => {
            if ((await owner.cancel()) === "unconfirmed")
              throw new Error("cancelUnconfirmed");
          }
        : undefined,
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

  confirmRestoredConfig(
    key: string,
    savedSelection: Record<string, unknown>,
  ): Promise<void> {
    return confirmSavedConfiguration(this.thread(key), savedSelection, {
      current: () => this.thread(key),
      emit: () => this.emit(key),
    });
  }

  recheckConfig(
    key: string,
    interest?: Pick<OpenInput, "inquiryCurrent" | "inquirySignal">,
  ): Promise<ThreadState> {
    return recheckConfiguration(
      this.thread(key),
      () => this.thread(key),
      () => this.permissionRevisions.get(key) ?? 0,
      (input, owner) => this.openTarget({ ...input, ...interest }, owner),
      () => this.emit(key),
    );
  }

  async reconnect(
    key: string,
    interest?: Pick<OpenInput, "inquiryCurrent" | "inquirySignal">,
  ): Promise<ThreadState | undefined> {
    const s = this.thread(key);
    if (!s || s.unrecoverable) return;
    try {
      if (hasConfigurationRecheckRecovery(s))
        return await this.recheckConfig(key, interest);
      return await this.open({
        ...interest,
        agentId: s.agentId,
        cwd: s.cwd,
        nativeSessionId: s.nativeSessionId,
      });
    } catch (error) {
      const failedKey = historyFailureKey(error);
      return failedKey ? this.thread(failedKey) : undefined;
    }
  }

  private removeThread(key: string): number {
    const previous = this.threads.get(key);
    if (previous) this.forks.retire(previous);
    this.threads.delete(key);
    const revision = this.permissionRevisions.get(key) ?? 0;
    this.permissionRevisions.delete(key);
    return revision;
  }

  async close(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (s && hasActiveFork(s)) throw new Error(STRINGS.repair.archiveBusy);
    this.stopConfirmation.clear(key);
    this.channels.delete(key);
    this.removeThread(key);
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
        this.removeThread(key);
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
        this.removeThread(key);
      }
      this.channels.delete(key);
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
    this.removeThread(key);
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
