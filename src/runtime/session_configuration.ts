import { invoke } from "@tauri-apps/api/core";
import {
  applyConfigCheck,
  configurationConfirmationBusy,
  confirmingMissingModel,
  releaseConfigurationPause,
  type ConfigCheck,
} from "./config_check";
import {
  configOptionChangeBlocked,
  protectedConfigIds,
  configChangeBusy,
} from "./protected_config";
import {
  normalizeConfigOptions,
  replaceConfigOptions,
} from "./session_projection";
import type { ThreadState } from "./session_types";
import type { ServiceIdentity } from "./credentials";
import { STRINGS } from "./strings";
import { replacePermissionEffect } from "./permission_effect";
import {
  prepareWorkspaceDecision,
  runWorkspaceDecision,
  workspaceDecisionError,
  workspaceDecisionOwns,
} from "./workspace_access_decision";
import type {
  WorkspaceAccessDecision,
  WorkspaceAccessResult,
  WorkspaceAccessScope,
} from "./workspace_access_types";
import { workspaceAccessCapability } from "./workspace_access_types";
import { WORKSPACE_ACCESS } from "./workspace_access_strings";
import { forgetSessionIdentity } from "./session_identity_types";
import { ConfigurationConfirmation } from "./session_configuration_confirmation";
import {
  originalSessionConfigBusy,
  originalSessionConfigTarget,
} from "./original_session_config";

interface Change {
  thread: ThreadState;
  ready: ConfigCheck | null;
  pending: ConfigCheck | null;
  defer: boolean;
  interrupted: boolean;
  confirmation?: ConfigurationConfirmation;
}

export interface ConfirmedConfigUpdate {
  configOptions: unknown;
  configOptionsModern?: boolean;
  configCheck: ConfigCheck;
  permissionConfigId: string | null;
  permissionState: ThreadState["permissionState"];
  permissionEffect?: unknown;
  service: ServiceIdentity | null;
}

function snapshotsMatch(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => snapshotsMatch(value, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && snapshotsMatch(a[key], b[key]))
  );
}

/** Publish a configuration only after its matching setter and saved baseline succeed. */
export class SessionConfiguration {
  readonly requests = new Map<string, Promise<unknown>>();
  private changes = new Map<string, Change>();

  constructor(
    private hooks: {
      thread: (key: string) => ThreadState | undefined;
      emit: () => void;
      finish: (thread: ThreadState) => void;
      permissionRevision: (key: string) => number;
    },
  ) {}

  changing(thread: ThreadState): boolean {
    const change = this.changes.get(thread.key);
    return change?.thread === thread && change.defer;
  }

  receiveCheck(thread: ThreadState, check: ConfigCheck): boolean {
    const change = this.changes.get(thread.key);
    if (change?.thread !== thread || !change.defer) return false;
    if (change.confirmation) {
      if (!thread.configuring || check.status !== "ready") {
        change.interrupted = true;
        change.pending = check;
      }
      change.ready = check.status === "ready" ? structuredClone(check) : null;
      // Ready is only an observation until the matching complete save receipt.
      // A later ready event cannot erase an intervening failure.
      return check.status === "ready";
    }
    if (
      !thread.configuring ||
      check.status === "record_failed" ||
      check.issues.some((issue) => issue.reason === "unknown") ||
      (change.ready && check.status !== "ready")
    )
      change.interrupted = true;
    change.ready = check.status === "ready" ? check : null;
    change.pending =
      check.status === "ready" || change.interrupted ? null : check;
    // Keep ordinary in-flight differences with the unconfirmed choices. The
    // configuring guard blocks sending without replacing any existing pause.
    // Unknown/save failure and later drift still block immediately.
    return check.status === "ready" || !change.interrupted;
  }

  receiveOptions(thread: ThreadState): void {
    const change = this.changes.get(thread.key);
    if (change?.thread === thread && change.confirmation)
      change.interrupted = true;
  }

  observe(thread: ThreadState): void {
    const change = this.changes.get(thread.key);
    if (
      change?.thread === thread &&
      change.confirmation &&
      !change.confirmation.owns()
    )
      change.interrupted = true;
  }

  async confirm(
    key: string,
    refresh: () => Promise<void>,
    originalReviewId?: string,
  ): Promise<boolean> {
    const s = this.hooks.thread(key);
    if (!s?.configCheck) return false;
    const originalTarget =
      originalReviewId === undefined ? null : originalSessionConfigTarget(s);
    if (originalReviewId !== undefined && !originalTarget) return false;
    const busy = originalTarget
      ? originalSessionConfigBusy
      : configurationConfirmationBusy;
    if (busy(s)) return false;
    const confirmation = new ConfigurationConfirmation(
      s,
      () => this.hooks.thread(key),
      () => this.hooks.permissionRevision(key),
      busy,
    );
    const change: Change = {
      thread: s,
      ready: null,
      pending: null,
      defer: true,
      interrupted: false,
      confirmation,
    };
    this.changes.set(key, change);
    s.configuring = true;
    s.configError = null;
    this.hooks.emit();
    const request = (async () => {
      let published = false;
      try {
        const result = originalTarget
          ? await invoke<unknown>("acp_confirm_original_session_config", {
              ...originalTarget,
              reviewId: originalReviewId,
              sameOriginalAccount: true,
            })
          : await invoke<unknown>("session_confirm_config", {
              agentId: s.agentId,
              cwd: s.cwd,
              sessionId: s.nativeSessionId,
              ...(confirmingMissingModel(s.configCheck)
                ? { connectionId: s.connectionId }
                : {}),
              displayed: structuredClone(confirmation.displayed),
            });
        if (this.hooks.thread(key) !== s) return false;
        const receipt = confirmation.receipt(result, change.ready);
        if (change.interrupted || !confirmation.owns() || !receipt)
          throw new Error(STRINGS.repair.confirmConfigFailed);
        replaceConfigOptions(
          s,
          receipt.options,
          receipt.configuration.configOptionsModern,
        );
        s.service = receipt.configuration.service ?? undefined;
        applyConfigCheck(s, receipt.check);
        releaseConfigurationPause(s);
        // Publication is atomic. Later pulled events belong to the ordinary
        // live view, even while the independent sidebar refresh is pending.
        published = true;
        this.changes.delete(key);
        this.requests.delete(key);
        s.configuring = false;
        this.hooks.emit();
        await refresh();
        return true;
      } catch {
        if (!published && confirmation.ownsFeedback())
          s.configError = STRINGS.repair.confirmConfigFailed;
        return published;
      } finally {
        if (this.changes.get(key) === change) {
          this.changes.delete(key);
          this.requests.delete(key);
          s.configuring = false;
        }
        this.hooks.emit();
      }
    })();
    this.requests.set(key, request);
    return request;
  }

  async decideWorkspaceAccess(
    key: string,
    decision: WorkspaceAccessDecision,
    expectedScope: WorkspaceAccessScope,
  ): Promise<WorkspaceAccessResult> {
    const s = this.hooks.thread(key);
    if (!s) throw { code: "changed", effect: "notDispatched" };
    const prepared = prepareWorkspaceDecision(s, decision, expectedScope);
    forgetSessionIdentity(s);
    s.configuring = true;
    // Do not defer, manufacture or confirm guard events produced by instruction reload.
    this.hooks.emit();
    const request = runWorkspaceDecision(prepared, () =>
      this.hooks.thread(key),
    );
    this.requests.set(key, request);
    try {
      return await request;
    } catch (error) {
      const failure = workspaceDecisionError(error);
      if (
        failure.code === "unavailable" &&
        workspaceDecisionOwns(prepared, this.hooks.thread(key))
      ) {
        const capability = workspaceAccessCapability(s.workspaceAccess);
        if (capability)
          s.workspaceAccess = {
            statusQuery: capability.statusQuery,
            provenance: capability.provenance,
          };
      }
      if (
        failure.effect === "unconfirmed" &&
        workspaceDecisionOwns(prepared, this.hooks.thread(key))
      )
        s.configError = WORKSPACE_ACCESS.decisionUnconfirmed;
      throw failure;
    } finally {
      if (this.requests.get(key) === request) {
        this.requests.delete(key);
        s.configuring = false;
      }
      this.hooks.emit();
      this.hooks.finish(s);
    }
  }

  async set(key: string, configId: string, value: unknown): Promise<void> {
    const s = this.hooks.thread(key);
    if (!s) throw new Error(STRINGS.repair.configFailed);
    if (configOptionChangeBlocked(s, configId))
      throw new Error(STRINGS.repair.configFailed);
    const option = s.configOptions.find((option) => option.id === configId)!;
    if (
      option.type === "boolean"
        ? typeof value !== "boolean"
        : !option.options.some((choice) => choice.value === value)
    )
      throw new Error(STRINGS.repair.configFailed);
    const protectedChoice = protectedConfigIds(
      s.configOptions,
      s.configCheck?.protectedIds,
    ).has(configId);
    const permission = s.permissionConfigId === configId;
    const revision = this.hooks.permissionRevision(key);
    const change: Change = {
      thread: s,
      ready: null,
      pending: null,
      defer: protectedChoice,
      interrupted: false,
    };
    this.changes.set(key, change);
    forgetSessionIdentity(s);
    if (permission) {
      s.permissionState = "changing";
      s.queuePaused = s.uncertainPrompt ? "uncertain" : "stopped";
    }
    s.configuring = true;
    s.configError = null;
    this.hooks.emit();
    const request = (async () => {
      try {
        if (configId === "mode" && s.modesSeparate) {
          await invoke("session_set_mode", {
            agentId: s.agentId,
            cwd: s.cwd,
            sessionId: s.nativeSessionId,
            modeId: String(value),
          });
          if (this.hooks.thread(key) !== s)
            throw new Error(STRINGS.repair.configFailed);
          // The Agent may have published a modern declaration during this call.
          if (!s.modesSeparate || s.connectionLost || s.reconnecting)
            throw new Error(STRINGS.repair.configFailed);
          forgetSessionIdentity(s);
          s.currentModeId = String(value);
          for (const option of s.configOptions)
            if (option.id === "mode") option.currentValue = s.currentModeId;
        } else {
          const updated = await invoke<ConfirmedConfigUpdate>(
            "session_set_config",
            {
              agentId: s.agentId,
              cwd: s.cwd,
              sessionId: s.nativeSessionId,
              configId,
              value,
            },
          );
          if (this.hooks.thread(key) !== s)
            throw new Error(STRINGS.repair.configFailed);
          if (
            !updated ||
            Array.isArray(updated) ||
            !Array.isArray(updated.configOptions) ||
            !updated.configCheck
          )
            throw new Error(STRINGS.repair.configFailed);
          const options = normalizeConfigOptions(updated.configOptions);
          const actual = options.find((option) => option.id === configId);
          if (
            s.connectionLost ||
            s.reconnecting ||
            s.connectionOutcomeUnknown ||
            change.interrupted ||
            (change.pending &&
              !snapshotsMatch(
                change.pending.current,
                updated.configCheck.current,
              )) ||
            actual?.type !== option.type ||
            actual?.currentValue !== value ||
            (protectedChoice && updated.configCheck.status !== "ready") ||
            (s.service
              ? !updated.service ||
                s.service.id !== updated.service.id ||
                s.service.fingerprint !== updated.service.fingerprint
              : updated.service !== null) ||
            (permission && this.hooks.permissionRevision(key) !== revision)
          )
            throw new Error(STRINGS.repair.configFailed);
          if (permission && updated.permissionState !== "ready")
            throw new Error(STRINGS.repair.configFailed);
          replaceConfigOptions(
            s,
            options,
            updated.configOptionsModern !== false,
          );
          applyConfigCheck(s, updated.configCheck);
          s.service = updated.service ?? undefined;
          s.permissionConfigId = updated.permissionConfigId ?? undefined;
          replacePermissionEffect(s, updated.permissionEffect);
          if (
            this.hooks.permissionRevision(key) === revision ||
            updated.permissionState !== "ready"
          )
            s.permissionState = updated.permissionState;
        }
      } catch {
        if (change.pending) applyConfigCheck(s, change.pending);
        if (permission) s.permissionState = "unknown";
        s.configError = STRINGS.repair.configFailed;
        throw new Error(s.configError);
      } finally {
        if (this.changes.get(key) === change) {
          this.changes.delete(key);
          this.requests.delete(key);
        }
        s.configuring = false;
        this.hooks.emit();
        this.hooks.finish(s);
      }
    })();
    this.requests.set(key, request);
    return request;
  }
}
