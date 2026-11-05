import { applyConfigCheck, type ConfigCheck } from "./config_check";
import {
  configurationPauseRevision,
  clearConfigurationPauseOwner,
  markConfigurationPause,
  ownsConfigurationPause,
} from "./configuration_pause";
import type { HistoryProjectionPhase } from "./history_replay_projection";
import { replacePermissionEffect } from "./permission_effect";
import { pauseQueue, type QueuePause } from "./queue";
import type { OpenInput } from "./session_open_input";
import { applyOpeningResult, inheritOpeningWork } from "./session_open_state";
import type { OpenResult } from "./session_open_types";
import {
  freshThreadState,
  normalizeConfigOptions,
  replaceConfigOptions,
} from "./session_projection";
import type { ConfigOptionView, ThreadState } from "./session_types";
import { STRINGS } from "./strings";
import { forgetSessionIdentity } from "./session_identity_types";

export interface OpeningIdentity {
  cwd: string;
  sessionId: string;
  connectionId: string;
}
interface PauseObservation {
  revision: number;
  configuration: boolean;
}

/** Constant-count metadata summary for baseline -> ordered history effects.
 * Body events go directly through the existing reducer into state. Only the
 * last full configuration, conditional legacy mode and permission facts are
 * retained here; there is no second transcript or replay/control queue. */
export class OpeningBaseline {
  readonly state: ThreadState;
  private identity?: OpeningIdentity;
  private accepted = false;
  private observed = false;
  private originalQueue?: ThreadState["queued"];
  private originalMembers: ThreadState["queued"] = [];
  private initialPause: QueuePause = null;
  private initialWorkPauseRevision = 0;
  private initialUncertain: ThreadState["uncertainPrompt"] = null;
  private firstTitle?: string;
  private lastOptions?: { options: ConfigOptionView[]; modern: boolean };
  private legacyDisabled = false;
  private legacyMode?: string;
  private legacyModeError?: unknown;
  private lastCheck?: ConfigCheck;
  private blocked = false;
  private permissionObserved = false;
  private permissionChanges = 0;
  private permissionId?: string;
  private permissionEffect?: unknown;
  private permissionState?: "unknown" | "required";
  private pendingPause?: PauseObservation;
  private lastPause?: { reason: QueuePause; configuration: boolean };

  constructor(
    private readonly input: OpenInput,
    private existing?: ThreadState,
    private readonly restoreQueue?: (state: ThreadState) => void,
  ) {
    // No ID or canonical path is inferred from an Agent event. The trusted
    // opening header identifies this private view before its first event.
    this.state = freshThreadState("", input.agentId, "", "");
  }

  identify(identity: OpeningIdentity, existing?: ThreadState): void {
    if (this.accepted) throw new Error(STRINGS.repair.reconnectFailed);
    if (this.identity) {
      if (!this.sameIdentity(identity))
        throw new Error(STRINGS.repair.reconnectFailed);
      return;
    }
    if (this.observed) throw new Error(STRINGS.repair.reconnectFailed);
    this.finishPause();
    this.identity = { ...identity };
    this.state.key = `${this.input.agentId}:${identity.cwd}:${identity.sessionId}`;
    this.state.cwd = identity.cwd;
    this.state.nativeSessionId = identity.sessionId;
    this.state.connectionId = identity.connectionId;
    this.existing = existing ?? this.existing;
    inheritOpeningWork(this.state, this.existing, this.restoreQueue);
    this.originalQueue = this.state.queued;
    this.originalMembers = this.state.queued.slice();
    this.state.queued = this.state.queued.slice();
    this.initialPause = this.state.queuePaused;
    this.initialWorkPauseRevision = this.existing
      ? configurationPauseRevision(this.existing)
      : 0;
    this.initialUncertain = this.state.uncertainPrompt;
    if (this.lastPause) {
      pauseQueue(this.state, this.lastPause.reason);
      if (this.lastPause.configuration) markConfigurationPause(this.state);
    }
  }

  /** Call immediately before the same event's existing reducer. The previous
   * reducer's actual pause write is sampled before any next event can run. */
  observe(event: unknown, phase: HistoryProjectionPhase = "history"): void {
    if (this.accepted) throw new Error(STRINGS.repair.reconnectFailed);
    if (!this.identity) {
      // session/new can ask an unsupported opening question before it returns
      // any session identity. Keep its exact notice in this same private view;
      // it grants no execution authority and does not admit early body events.
      if (
        !event ||
        typeof event !== "object" ||
        Object.hasOwn(event, "update") ||
        (event as { kind?: unknown }).kind !== "elicitationUnavailable"
      )
        throw new Error(STRINGS.repair.reconnectFailed);
      this.finishPause();
      this.pendingPause = {
        revision: configurationPauseRevision(this.state),
        configuration: false,
      };
      return;
    }
    this.observed = true;
    this.finishPause();
    if (!event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    const ownUpdate = Object.hasOwn(e, "update");
    const kind = ownUpdate ? undefined : e.kind;
    this.pendingPause = {
      revision: configurationPauseRevision(this.state),
      configuration: kind === "configCheck",
    };
    if (kind === "configOptions") {
      const options = normalizeConfigOptions(e.options);
      const modern = e.modern !== false;
      this.lastOptions = { options, modern };
      if (
        modern ||
        options.some((o) => o.id === "mode" || o.category === "mode")
      )
        this.legacyDisabled = true;
    } else if (kind === "configCheck") {
      this.lastCheck = e.check as ConfigCheck;
      if (this.lastCheck.status !== "ready") this.blocked = true;
    } else if (kind === "permissionState") {
      this.permissionObserved = true;
      if (typeof e.permissionConfigId === "string")
        this.permissionId = e.permissionConfigId;
      this.permissionEffect = e.permissionEffect;
      if (e.permissionState === "unknown" || e.permissionState === "required") {
        this.permissionState = e.permissionState;
        this.permissionChanges++;
      }
    } else if (ownUpdate) {
      const update = e.update as Record<string, unknown> | null;
      if (
        phase === "history" &&
        update?.sessionUpdate === "config_option_update"
      )
        // Preserve the old historical conversion guard. The displayed raw
        // config update still follows the unchanged event reducer.
        normalizeConfigOptions(update.configOptions);
      if (
        update?.sessionUpdate === "current_mode_update" &&
        !this.legacyDisabled
      ) {
        try {
          this.legacyMode = String(update.currentModeId ?? "");
        } catch (error) {
          this.legacyModeError ??= error;
        }
      }
      if (
        update?.sessionUpdate === "session_info_update" &&
        this.firstTitle === undefined &&
        typeof update.title === "string" &&
        update.title.trim()
      )
        this.firstTitle = update.title;
    }
  }

  accept(
    result: OpenResult,
    savedTitle: string | null | undefined,
    existing?: ThreadState,
  ): ThreadState {
    if (
      !this.identity ||
      this.accepted ||
      !this.sameIdentity({
        cwd: result.cwd,
        sessionId: result.nativeSessionId,
        connectionId: result.connectionId ?? "",
      }) ||
      (existing !== undefined && existing !== this.existing)
    )
      throw new Error(STRINGS.repair.reconnectFailed);
    this.finishPause();
    const state = this.state;
    const uncertain = state.uncertainPrompt;
    state.queuePaused = this.initialPause;
    clearConfigurationPauseOwner(state);
    // The returned permission baseline precedes historical turn-end effects.
    state.uncertainPrompt = this.initialUncertain;
    try {
      applyOpeningResult(
        state,
        this.input,
        result,
        savedTitle,
        this.existing?.title,
      );
    } finally {
      state.uncertainPrompt = uncertain;
    }
    const initialLegacy = state.modesSeparate;
    if (initialLegacy && this.legacyModeError !== undefined)
      throw this.legacyModeError;
    if (initialLegacy && this.legacyMode !== undefined) {
      forgetSessionIdentity(state);
      state.currentModeId = this.legacyMode;
      for (const option of state.configOptions)
        if (option.category === "mode") option.currentValue = this.legacyMode;
    }
    if (this.legacyDisabled) state.modesSeparate = false;
    if (this.lastOptions)
      replaceConfigOptions(
        state,
        this.lastOptions.options,
        this.lastOptions.modern,
      );
    if (this.permissionObserved) {
      if (this.permissionId !== undefined)
        state.permissionConfigId = this.permissionId;
      replacePermissionEffect(state, this.permissionEffect);
      if (this.permissionState) state.permissionState = this.permissionState;
    }
    if (this.blocked && state.queuePaused === null) {
      state.queuePaused = "unavailable";
      markConfigurationPause(state);
    }
    if (this.lastCheck) applyConfigCheck(state, this.lastCheck);
    if (this.lastPause) {
      pauseQueue(state, this.lastPause.reason);
      if (this.lastPause.configuration) markConfigurationPause(state);
    }
    state.metaDirty = !state.title?.trim() && this.firstTitle !== undefined;
    if (state.metaDirty) state.title = this.firstTitle!;
    // Commit only removals that this private reducer actually performed. Any
    // newly added user queue entry remains in its original container.
    if (this.originalQueue) {
      const removed = new Set(
        this.originalMembers.filter((entry) => !state.queued.includes(entry)),
      );
      for (let index = this.originalQueue.length - 1; index >= 0; index--)
        if (removed.has(this.originalQueue[index]))
          this.originalQueue.splice(index, 1);
      state.queued = this.originalQueue;
    }
    if (this.existing) {
      // History owns the returned configuration, not later user work choices.
      // Keeping or discarding a retry copy never settles its external outcome.
      state.workEnabled = this.existing.workEnabled;
      if (
        this.initialUncertain &&
        state.uncertainPrompt === this.initialUncertain &&
        this.existing.uncertainPrompt === null &&
        !this.existing.queued.includes(this.initialUncertain)
      )
        state.uncertainPrompt = null;
      if (
        this.existing.queuePaused !== null &&
        configurationPauseRevision(this.existing) !==
          this.initialWorkPauseRevision
      ) {
        const pause = this.existing.queuePaused;
        // A confirmed historical end can clear the old unknown copy while a
        // user edits later work. Keep that edit paused without reviving unknown.
        pauseQueue(
          state,
          pause === "uncertain" &&
            !state.uncertainPrompt &&
            !state.connectionOutcomeUnknown &&
            !state.stopUnconfirmed
            ? "stopped"
            : pause,
        );
      }
    }
    this.accepted = true;
    return state;
  }

  get acceptedPermissionChanges(): number {
    return this.accepted ? this.permissionChanges : 0;
  }

  private sameIdentity(identity: OpeningIdentity): boolean {
    return (
      this.identity?.cwd === identity.cwd &&
      this.identity.sessionId === identity.sessionId &&
      this.identity.connectionId === identity.connectionId
    );
  }

  private finishPause(): void {
    const pending = this.pendingPause;
    this.pendingPause = undefined;
    if (
      pending &&
      !pending.configuration &&
      configurationPauseRevision(this.state) !== pending.revision
    )
      this.lastPause = {
        reason: this.state.queuePaused,
        configuration: ownsConfigurationPause(this.state),
      };
  }
}
