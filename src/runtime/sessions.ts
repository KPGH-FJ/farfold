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
 * `permissionsCancelled` | `turnEnd` | `connectionLost` | `notification`.
 *
 * Naming note: user-facing vocabulary is "会话/thread"; `session*` stays
 * inside this runtime module only (AGENTS.md vocabulary rule).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useSyncExternalStore } from "react";
import { applyElicitation, paneCards, appendToolOutput } from "./artifacts";
import type { ElicitationView, PaneCard } from "./artifacts";
import { STRINGS } from "./strings";
import { PermissionActions } from "./permissions";
import { StopConfirmation } from "./stop_confirmation";
import {
  canDrain,
  pauseQueue,
  removeQueued,
  type PromptAdmission,
} from "./queue";

export type { ElicitationView, PaneCard };
export { applyElicitation, paneCards };

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
}

/** `session_list` merged entry (backend `SessionListEntry`, camelCase). */
export interface SessionListEntry {
  id: string | null;
  nativeSessionId: string;
  title: string | null;
  updatedAt: number | null;
  /** `agent` when the agent's own list reported it, else `farfold`. */
  source: string;
  pinned: boolean;
  archived: boolean;
}

/** An agent-side session with no Farfold index row yet — shown in the
 *  sidebar under `source: "agent"`; opening it resumes by native id and
 *  materializes the index row. */
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
export * from "./session_types";
export {
  freshThreadState,
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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ThreadsSnapshot {
  version: number;
  threads: Map<string, ThreadState>;
  index: IndexRow[];
  /** Agent-side sessions with no index row (`source: "agent"`). */
  agentRows: AgentOnlyRow[];
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
}

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
  private agentRows: AgentOnlyRow[] = [];
  private autoArchiveDays = 0;
  private listeners = new Set<() => void>();
  private notifications = new ThreadNotifications();
  subscribeThread = (key: string, fn: () => void) =>
    this.notifications.subscribe(key, fn);
  threadVersion = (key: string) => this.notifications.version(key);
  private snapshot: ThreadsSnapshot = {
    version: 0,
    threads: this.threads,
    index: this.indexRows,
    agentRows: this.agentRows,
    autoArchiveDays: this.autoArchiveDays,
  };
  /** channel kept alive per thread key. */
  private channels = new Map<string, Channel<unknown>>();
  /** dedupe concurrent opens (same agent+cwd+native target). */
  private openings = new Map<string, Promise<ThreadState>>();
  /** Unprompted ("draft") conversations per agent+cwd — re-picking the
   *  same pair reuses the draft instead of spawning another session. */
  private drafts = new Map<string, string>();
  private permissions = new PermissionActions(
    (key) => this.thread(key),
    () => this.emit(),
  );
  private configRequests = new Map<string, Promise<void>>();
  decidePermission = (
    key: string,
    requestId: string,
    optionId: string,
    label: string,
    allow: boolean,
    remember = false,
  ): void =>
    this.permissions.decide(key, requestId, optionId, label, allow, remember);
  undoPermissionDecision = (key: string, requestId: string): void =>
    this.permissions.undo(key, requestId);

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ThreadsSnapshot => this.snapshot;

  private emit(key?: string): void {
    this.notifications.flush(key);
    this.snapshot = {
      version: this.snapshot.version + 1,
      threads: this.threads,
      index: this.indexRows,
      agentRows: this.agentRows,
      autoArchiveDays: this.autoArchiveDays,
    };
    for (const fn of this.listeners) fn();
  }

  thread(key: string): ThreadState | undefined {
    return this.threads.get(key);
  }

  needsAttention(s: ThreadState): boolean {
    return (
      Boolean(s.openError) ||
      s.unrecoverable ||
      s.stopUnconfirmed ||
      s.modelDrift ||
      s.pendingPermissions.length > 0 ||
      s.pendingElicitation !== null ||
      (s.connectionLost && s.items.length > 0)
    );
  }

  async refreshIndex(): Promise<void> {
    try {
      this.indexRows = await invoke<IndexRow[]>("session_index_list");
    } catch {
      // Keep the last known index; a failed read must not blank the sidebar.
    }
    // Merge agent-side `session/list` for every known (agent, cwd) pair:
    // entries the agent reports but Farfold never indexed appear as
    // `source: "agent"` sidebar rows that resume on click.
    const pairs = new Map<string, { agentId: string; cwd: string }>();
    for (const row of this.indexRows) {
      pairs.set(`${row.agentId}${row.cwd}`, {
        agentId: row.agentId,
        cwd: row.cwd,
      });
    }
    const agentRows: AgentOnlyRow[] = [];
    await Promise.all(
      [...pairs.values()].map(async ({ agentId, cwd }) => {
        try {
          // `session_list` lazily connects — only call it when this
          // (agent, cwd) connection is already up, otherwise a passive
          // sidebar refresh would spawn agent processes (must not
          // auto-reconnect at startup).
          const statuses = await invoke<{ state: string; cwd: string }[]>(
            "agent_status",
            { agentId },
          );
          const live = statuses.some(
            (status) => status.state === "ready" && status.cwd === cwd,
          );
          if (!live) return;
          const entries = await invoke<SessionListEntry[]>("session_list", {
            agentId,
            cwd,
          });
          for (const entry of entries) {
            if (entry.source !== "agent" || entry.id !== null) continue;
            agentRows.push({
              key: `${agentId}:${cwd}:${entry.nativeSessionId}`,
              agentId,
              cwd,
              nativeSessionId: entry.nativeSessionId,
              title: entry.title,
              updatedAt: entry.updatedAt ?? 0,
            });
          }
        } catch {
          // No live connection for this pair — meta rows alone stand.
        }
      }),
    );
    this.agentRows = agentRows;
    try {
      const days = await invoke<unknown>("settings_get", {
        key: "autoArchiveDays",
      });
      this.autoArchiveDays =
        typeof days === "number" && days >= 0
          ? days
          : DEFAULT_AUTO_ARCHIVE_DAYS;
    } catch {
      this.autoArchiveDays = DEFAULT_AUTO_ARCHIVE_DAYS;
    }
    this.emit();
  }

  private applyChannelEvent(key: string, event: unknown): void {
    const s = this.threads.get(key);
    if (!s || !event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    if (e.kind === "configCheck") {
      applyConfigCheck(s, e.check as ConfigCheck);
    } else if (e.kind === "permissionRequest") {
      applyPermissionRequest(s, {
        requestId: String(e.requestId ?? ""),
        toolCall: e.toolCall,
        options: e.options,
      });
    } else if (e.kind === "turnEnd") {
      if (!s.running && !s.uncertainPrompt) return;
      this.stopConfirmation.clear(key);
      if (s.uncertainPrompt) {
        removeQueued(s, s.uncertainPrompt);
        s.uncertainPrompt = null;
      }
      applyTurnEnd(s, {
        stopReason: typeof e.stopReason === "string" ? e.stopReason : undefined,
        error: typeof e.error === "string" ? e.error : undefined,
        failure: e.failure,
      });
      this.emit(key);
      void this.drainQueue(key);
      void this.refreshIndex();
      return;
    } else if (e.kind === "connectionLost") {
      this.stopConfirmation.clear(key);
      applyConnectionLost(s);
      this.channels.delete(key);
      pauseQueue(s, s.uncertainPrompt ? "uncertain" : "unavailable");
    } else if (e.kind === "permissionsCancelled") {
      s.pendingPermissions = [];
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
      const draftKey = this.drafts.get(`${input.agentId}|${input.cwd}`);
      const draft = draftKey ? this.threads.get(draftKey) : undefined;
      if (draft && draft.identity === "draft" && !draft.openError) {
        return Promise.resolve(draft);
      }
    }
    const openingKey = `${input.agentId} ${input.cwd} ${input.nativeSessionId ?? (input.fresh ? "fresh" : "-")}`;
    const pending = this.openings.get(openingKey);
    if (pending) return pending;

    const promise = (async (): Promise<ThreadState> => {
      const channel = new Channel<unknown>();
      const buffered: unknown[] = [];
      let boundKey: string | null = null;
      channel.onmessage = (event) => {
        if (boundKey) {
          if (this.channels.get(boundKey) === channel)
            this.applyChannelEvent(boundKey, event);
        } else buffered.push(event);
      };
      const result = await invoke<OpenResult>("session_open", {
        agentId: input.agentId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        configOptions: input.configOptions ?? null,
        channel,
      });
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
      state.resumed = result.resumed;
      state.identity = result.resumed ? "established" : "draft";
      if (existing) {
        state.title = existing.title;
        state.queued = existing.queued;
        state.queuePaused = existing.queuePaused ?? "unavailable";
        state.uncertainPrompt = existing.uncertainPrompt;
        state.stopUnconfirmed = existing.stopUnconfirmed;
        state.workEnabled = existing.workEnabled;
      }
      state.configOptions = normalizeConfigOptions(result.configOptions);
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
      this.threads.set(key, state);
      this.channels.set(key, channel);
      if (!result.resumed) {
        this.drafts.set(`${input.agentId}|${input.cwd}`, key);
      }
      boundKey = key;
      for (const event of buffered.splice(0)) {
        this.applyChannelEvent(key, event);
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
          old.identity = "established";
          old.reconnecting = false;
          old.openError = STRINGS.repair.reconnectFailed;
          old.connectionLost = true;
          old.unrecoverable = String(error).includes("不支持恢复");
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
  async newAfterModelDrift(key: string): Promise<ThreadState> {
    const old = this.thread(key);
    if (!old?.modelDrift) throw new Error(STRINGS.repair.newDraftFailed);
    return this.open({ agentId: old.agentId, cwd: old.cwd, fresh: true });
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
  async send(key: string, blocks: PromptBlock[]): Promise<void> {
    const s = this.thread(key);
    if (!s || !blocks.length) return;
    if (s.configuring) await this.configRequests.get(key);
    if (s.configError) throw new Error(STRINGS.repair.configFailed);
    s.queued.push(blocks);
    this.emit();
    await this.drainQueue(key);
  }

  private async drainQueue(key: string): Promise<void> {
    const s = this.thread(key);
    if (!s || !canDrain(s)) return;
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
        .filter(
          (b) =>
            b.type === "image" ||
            b.type === "resource_link" ||
            b.type === "resource",
        )
        .map((b) => ({
          name:
            b.type === "image"
              ? "image"
              : b.type === "resource"
                ? b.resource.uri
                : b.name,
          uri:
            b.type === "resource_link"
              ? b.uri
              : b.type === "resource"
                ? b.resource.uri
                : undefined,
          mimeType: b.type === "image" ? b.mimeType : undefined,
        })),
      streaming: false,
      time: Date.now(),
    };
    s.items.push(item);
    s.roundItemBase = s.items.length;
    this.emit();
    try {
      const result = await invoke<PromptAdmission>("session_prompt", {
        agentId: s.agentId,
        cwd: s.cwd,
        sessionId: s.nativeSessionId,
        content: blocks,
      });
      if (this.thread(key) !== s) return;
      if (result.status === "accepted") {
        removeQueued(s, blocks);
        s.identity = "established";
        this.drafts.delete(`${s.agentId}|${s.cwd}`);
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
      } else {
        s.running = false;
        if (result.status === "unknown") {
          s.identity = "established";
          s.uncertainPrompt = blocks;
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
    } catch {
      // IPC failure may happen after dispatch: never automatically repeat it.
      s.running = false;
      s.identity = "established";
      s.uncertainPrompt = blocks;
      pauseQueue(s, "uncertain");
    } finally {
      s.submitting = false;
      this.emit();
      if (canDrain(s)) void this.drainQueue(key);
    }
  }

  async continueQueue(key: string): Promise<void> {
    const s = this.thread(key);
    if (
      !s ||
      s.uncertainPrompt ||
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

  updateWork(cwd: string, enabled: Record<string, boolean>): void {
    for (const s of this.threads.values())
      if (s.cwd === cwd) {
        s.workEnabled = enabled[s.agentId] ?? true;
        if (!s.workEnabled) pauseQueue(s, "work_disabled");
      }
    this.emit();
  }

  dequeue(key: string, index: number): void {
    const s = this.thread(key);
    if (!s || (s.submitting && index === 0)) return;
    if (s.queued[index] === s.uncertainPrompt) s.uncertainPrompt = null;
    s.queued.splice(index, 1);
    this.emit();
  }

  private stopConfirmation = new StopConfirmation();

  async cancel(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (!s || !s.running || s.stopping) return;
    pauseQueue(s, "stopped");
    s.stopping = true;
    this.stopConfirmation.start(
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
      if (this.thread(key) !== s || !s.running) return;
      this.stopConfirmation.clear(key);
      s.stopping = false;
      s.stopUnconfirmed = true;
      pauseQueue(s, "uncertain");
      this.emit();
    }
    // "停止中…" until turnEnd settles the round — do not flip running here.
  }

  /** Open the artifact drawer; cards derive from thread items. */
  openArtifactPane(key: string): void {
    const s = this.threads.get(key);
    if (!s) return;
    s.artifactPaneOpen = true;
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
  async respondElicitation(
    key: string,
    action: "accept" | "decline" | "cancel",
    values?: Record<string, unknown>,
  ): Promise<void> {
    const s = this.threads.get(key);
    const elicitation = s?.pendingElicitation;
    if (!s || !elicitation) return;
    const requestId = elicitation.requestId;
    s.pendingElicitation = null;
    this.emit();
    try {
      await invoke("session_elicitation_respond", {
        requestId,
        action,
        content: action === "accept" ? (values ?? {}) : null,
      });
    } catch (error) {
      s.items.push({
        kind: "settled",
        id: nextItemId(),
        status: "failed",
        error: String(error),
        diffCount: 0,
        artifactCount: 0,
        time: Date.now(),
      });
      this.emit();
    }
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
      modelConfigOption(s.configOptions)?.id === configId
    )
      throw new Error(STRINGS.repair.modelLocked);
    if (s.submitting || s.configuring)
      throw new Error(STRINGS.repair.configFailed);
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
          s.configOptions = normalizeConfigOptions(updated);
          if (
            synthesizedMode &&
            !s.configOptions.some((o) => o.id === "mode")
          ) {
            s.configOptions = [...s.configOptions, synthesizedMode];
          }
        }
      } catch {
        s.configError = STRINGS.repair.configFailed;
        throw new Error(s.configError);
      } finally {
        s.configuring = false;
        this.configRequests.delete(key);
        this.emit();
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
    if (!s) return;
    try {
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
    if (s) this.drafts.delete(`${s.agentId}|${s.cwd}`);
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
    await this.refreshIndex();
  }

  async setPinned(rowId: string, pinned: boolean): Promise<void> {
    await invoke("session_meta_pin", { sessionId: rowId, pinned });
    await this.refreshIndex();
  }

  async setArchived(rowId: string, archived: boolean): Promise<void> {
    await invoke("session_meta_archive", { sessionId: rowId, archived });
    await this.refreshIndex();
  }

  /** Discard an unprompted draft: close the agent session and tombstone it
   *  so `session/list` cannot resurface it as an agent-side row. */
  async discardDraft(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (!s || s.identity !== "draft" || s.submitting) return;
    this.threads.delete(key);
    this.channels.delete(key);
    this.drafts.delete(`${s.agentId}|${s.cwd}`);
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
    if (s) this.drafts.delete(`${s.agentId}|${s.cwd}`);
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
  useSyncExternalStore(subscribe, getVersion);
  return key ? (threads.thread(key) ?? null) : null;
}

// Re-exported for existing `../runtime/sessions` imports; the sidebar
// view-model helpers now live in `runtime/sidebar.ts`.
export { basename, groupSidebarRows, relativeTime, shortPath } from "./sidebar";
export type { SidebarRow } from "./sidebar";
