import { invoke } from "@tauri-apps/api/core";
import { applyConfigCheck, type ConfigCheck } from "./config_check";
import {
  configOptionChangeBlocked,
  protectedConfigIds,
} from "./protected_config";
import {
  normalizeConfigOptions,
  replaceConfigOptions,
} from "./session_projection";
import type { ThreadState } from "./session_types";
import type { ServiceIdentity } from "./credentials";
import { STRINGS } from "./strings";

interface Change {
  thread: ThreadState;
  ready: ConfigCheck | null;
  pending: ConfigCheck | null;
  defer: boolean;
  interrupted: boolean;
}

export interface ConfirmedConfigUpdate {
  configOptions: unknown;
  configOptionsModern?: boolean;
  configCheck: ConfigCheck;
  permissionConfigId: string | null;
  permissionState: ThreadState["permissionState"];
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
  readonly requests = new Map<string, Promise<void>>();
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

  async set(key: string, configId: string, value: unknown): Promise<void> {
    const s = this.hooks.thread(key);
    if (!s) return;
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
          if (this.hooks.thread(key) !== s) return;
          if (s.connectionLost || s.reconnecting)
            throw new Error(STRINGS.repair.configFailed);
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
          if (this.hooks.thread(key) !== s) return;
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
            ((protectedChoice || permission) &&
              actual?.currentValue !== value) ||
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
        if (this.changes.get(key) === change) this.changes.delete(key);
        this.requests.delete(key);
        s.configuring = false;
        this.hooks.emit();
        this.hooks.finish(s);
      }
    })();
    this.requests.set(key, request);
    return request;
  }
}
