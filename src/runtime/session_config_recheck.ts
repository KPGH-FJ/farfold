import { invoke } from "@tauri-apps/api/core";
import type { OpenInput, OpenResult } from "./sessions";
import type { ThreadState } from "./session_types";
import { configChangeBusy } from "./protected_config";
import {
  applyConfigCheck,
  configurationInputBusy,
  ownsConfigurationPause,
  markConfigurationPause,
  releaseConfigurationPause,
  sameConfigurationSnapshot,
} from "./config_check";
import type { ConfigCheck } from "./config_check";
import { STRINGS } from "./strings";
import { configurationPauseRevision } from "./configuration_pause";

interface RetryContext {
  agent: string;
  cwd: string;
  native: string;
  service: ThreadState["service"] | null;
  check: ThreadState["configCheck"];
  permissionId: ThreadState["permissionConfigId"];
  permissionState: ThreadState["permissionState"];
  permissionRevision: number;
}
const failedRechecks = new WeakMap<ThreadState, RetryContext>();
export function hasConfigurationRecheckRecovery(s: ThreadState): boolean {
  return failedRechecks.has(s);
}
function sameSource(
  service: ThreadState["service"] | null,
  target: RetryContext["service"],
): boolean {
  return target
    ? service?.id === target.id && service.fingerprint === target.fingerprint
    : !service;
}
function validRetry(s: ThreadState): RetryContext | undefined {
  const retry = failedRechecks.get(s);
  return retry &&
    s.agentId === retry.agent &&
    s.cwd === retry.cwd &&
    s.nativeSessionId === retry.native &&
    sameSource(s.service, retry.service) &&
    s.permissionConfigId === retry.permissionId &&
    s.permissionState === retry.permissionState &&
    s.configCheck === retry.check
    ? retry
    : undefined;
}

export function configRecheckBusy(s: ThreadState, checking = false): boolean {
  const retry = validRetry(s);
  return (
    configChangeBusy({
      ...s,
      ...(checking ? { reconnecting: false } : {}),
      ...(retry
        ? { connectionLost: false, openError: null, historyUnavailable: null }
        : {}),
    }) || configurationInputBusy(s)
  );
}

/** A transient owner for one user-requested local detach and official reload. */
export class ConfigurationRecheck {
  private readonly pause;
  private readonly ownedPause;
  private readonly check;
  private readonly permissionRevision;
  private readonly permissionId;
  private readonly permissionState;
  private readonly pauseRevision;
  private readonly target;
  private interrupted: ConfigCheck | null = null;
  private observedReady = false;
  detached = false;
  constructor(
    readonly original: ThreadState,
    private readonly current: () => ThreadState | undefined,
    private readonly revision: () => number,
  ) {
    this.pause = original.queuePaused;
    this.ownedPause = ownsConfigurationPause(original);
    this.check = original.configCheck;
    this.permissionRevision = revision();
    this.permissionId = original.permissionConfigId;
    this.permissionState = original.permissionState;
    this.pauseRevision = configurationPauseRevision(original);
    this.target = {
      agent: original.agentId,
      cwd: original.cwd,
      native: original.nativeSessionId,
      service: original.service ? { ...original.service } : null,
    };
  }

  validateOwner(): void {
    const s = this.original;
    if (
      this.current() !== s ||
      s.agentId !== this.target.agent ||
      s.cwd !== this.target.cwd ||
      s.nativeSessionId !== this.target.native ||
      !sameSource(s.service, this.target.service) ||
      configRecheckBusy(s, true) ||
      this.revision() !== this.permissionRevision ||
      (s.configCheck !== this.check &&
        (s.configCheck?.status === "record_failed" ||
          s.configCheck?.issues.some((issue) => issue.reason === "unknown")))
    )
      throw new Error(STRINGS.repair.recheckConfigFailed);
  }

  observe(event: unknown): void {
    const value = event as { kind?: string; check?: ConfigCheck } | null;
    if (value?.kind !== "configCheck" || !value.check) return;
    const check = value.check;
    if (
      check.status === "record_failed" ||
      check.issues.some((issue) => issue.reason === "unknown") ||
      (this.observedReady && check.status !== "ready")
    )
      this.interrupted = check;
    if (check.status === "ready") this.observedReady = true;
  }

  async detach(): Promise<void> {
    await invoke("session_detach_for_config_check", {
      agentId: this.original.agentId,
      cwd: this.original.cwd,
      sessionId: this.original.nativeSessionId,
      ...(validRetry(this.original) ? { allowAlreadyDetached: true } : {}),
    });
    this.detached = true;
    this.validateOwner();
  }

  validateResult(result: OpenResult): void {
    this.validateOwner();
    const s = this.original;
    const sameSource = this.target.service
      ? result.service?.id === this.target.service.id &&
        result.service.fingerprint === this.target.service.fingerprint
      : result.service === null;
    if (
      !result.resumed ||
      result.nativeSessionId !== s.nativeSessionId ||
      result.cwd !== s.cwd ||
      !sameSource
    )
      throw new Error(STRINGS.repair.recheckConfigFailed);
  }

  finish(state: ThreadState, result: OpenResult): void {
    if (this.interrupted) applyConfigCheck(state, this.interrupted);
    // The new route's latest check must agree with its acknowledged full snapshot.
    const ready =
      !this.interrupted &&
      result.configCheck?.status === "ready" &&
      state.configCheck?.status === "ready" &&
      sameConfigurationSnapshot(
        state.configCheck.current,
        result.configCheck.current,
      ) &&
      matchesOptions(state);
    if (!ready) state.configError = STRINGS.repair.recheckConfigFailed;
    if (!state.configCheck) state.modelDrift = true;
    const original = this.original;
    const unchangedPause = original.queuePaused === this.pause;
    const ownsPause = this.ownedPause && ownsConfigurationPause(original);
    // This transfer is exclusive to this explicit owner; ordinary opens never inherit it.
    if (
      unchangedPause &&
      configurationPauseRevision(original) === this.pauseRevision &&
      configurationPauseRevision(state) === 0 &&
      (ownsPause || this.pause === null) &&
      state.queuePaused === "unavailable" &&
      !configRecheckBusy(original, true) &&
      this.revision() === this.permissionRevision
    )
      markConfigurationPause(state);
    if (ready) releaseConfigurationPause(state);
  }

  rememberFailure(): void {
    if (this.detached && this.current() === this.original) {
      const observedCheck = this.original.configCheck;
      // An identical known observation can arrive as a new object during detach.
      // Keep changed, unknown and failed-save checks outside this retry owner.
      const sameKnownCheck =
        observedCheck &&
        observedCheck.status !== "record_failed" &&
        !observedCheck.issues.some((issue) => issue.reason === "unknown") &&
        sameConfigurationSnapshot(observedCheck, this.check);
      failedRechecks.set(this.original, {
        ...this.target,
        check: sameKnownCheck ? observedCheck : this.check,
        permissionId: this.permissionId,
        permissionState: this.permissionState,
        permissionRevision: this.permissionRevision,
      });
    }
  }
}

function matchesOptions(state: ThreadState): boolean {
  const ids = state.configCheck?.protectedIds ?? [];
  if (!ids.length) return true;
  const current = state.configCheck?.current as { choices?: unknown } | null;
  if (!Array.isArray(current?.choices)) return false;
  return ids.every((id) => {
    const option = state.configOptions.find((option) => option.id === id);
    const choices = current.choices as {
      id?: string;
      type?: string;
      value?: unknown;
    }[];
    const matching = choices.filter((choice) => choice.id === id);
    return (
      option &&
      matching.length === 1 &&
      matching[0].type === option.type &&
      Object.is(matching[0].value, option.currentValue)
    );
  });
}

export async function recheckConfiguration(
  state: ThreadState | undefined,
  current: () => ThreadState | undefined,
  revision: () => number,
  open: (input: OpenInput, owner: ConfigurationRecheck) => Promise<ThreadState>,
  emit: () => void,
): Promise<ThreadState> {
  if (
    !state ||
    state.identity !== "established" ||
    configRecheckBusy(state) ||
    (!state.modelDrift && !state.configError)
  )
    throw new Error(STRINGS.repair.recheckConfigFailed);
  const owner = new ConfigurationRecheck(state, current, revision);
  const retry = validRetry(state);
  if (retry && retry.permissionRevision !== revision())
    throw new Error(STRINGS.repair.recheckConfigFailed);
  try {
    const result = await open(
      {
        agentId: state.agentId,
        cwd: state.cwd,
        nativeSessionId: state.nativeSessionId,
        service: state.service
          ? { id: state.service.id, model: state.service.model }
          : null,
      },
      owner,
    );
    failedRechecks.delete(state);
    return result;
  } catch {
    if (current() === state) {
      owner.rememberFailure();
      state.configError = STRINGS.repair.recheckConfigFailed;
      emit();
    }
    throw new Error(STRINGS.repair.recheckConfigFailed);
  }
}
