import { invoke } from "@tauri-apps/api/core";
import {
  releaseConfigurationPause,
  sameConfigurationSnapshot,
  type ConfigCheck,
} from "./config_check";
import { configChangeBusyReason, protectedConfigIds } from "./protected_config";
import { modelConfigOption } from "./session_projection";
import type { ThreadState } from "./session_types";
import { STRINGS } from "./strings";
import {
  requireSavedConfigurationOption,
  requireRestoredConfigurationValues,
  ConfigurationConfirmationError,
  configurationConfirmationRejection,
} from "./configuration_restore_feedback";

interface RestoreHooks {
  current(): boolean;
  validateService(): Promise<void>;
  set(id: string, value: unknown): Promise<void>;
  confirm(selection: Record<string, unknown>): Promise<void>;
}

/** Keep notification values useful without turning protected defaults into intent. */
export function mirroredConfigurationChoice(
  state: ThreadState,
  saved: Record<string, unknown>,
) {
  const protectedIds = protectedConfigIds(
    state.configOptions,
    state.configCheck?.protectedIds,
  );
  return Object.fromEntries([
    ...Object.entries(saved).filter(([id]) => protectedIds.has(id)),
    ...state.configOptions
      .filter((option) => !protectedIds.has(option.id))
      .map((option) => [option.id, option.currentValue]),
  ]);
}

/** Original intent only: service model values come from the explicit source choice. */
export function configurationRestoreIntent(
  state: ThreadState,
  selection: Record<string, unknown>,
  serviceModel?: string,
) {
  const saved = structuredClone(selection);
  const model = modelConfigOption(state.configOptions);
  if (
    serviceModel &&
    model &&
    protectedConfigIds(state.configOptions).has(model.id)
  ) {
    if (
      model.currentValue !== serviceModel ||
      (Object.hasOwn(saved, model.id) && saved[model.id] !== serviceModel)
    )
      throw new Error(STRINGS.repair.configFailed);
    saved[model.id] = serviceModel;
  }
  return saved;
}

/** Restore the original complete map before protecting its declared choices. */
export async function restoreSavedConfiguration(
  state: ThreadState,
  selection: Record<string, unknown>,
  hooks: RestoreHooks,
): Promise<boolean> {
  const saved = structuredClone(selection);
  const modelId = modelConfigOption(state.configOptions)?.id;
  const choices = Object.entries(saved).sort(
    ([a], [b]) => Number(b === modelId) - Number(a === modelId),
  );
  for (const [id, value] of choices) {
    if (!hooks.current()) return false;
    const option = requireSavedConfigurationOption(
      state.configOptions,
      id,
      value,
    );
    if (value !== option.currentValue) await hooks.set(id, value);
    if (!hooks.current()) return false;
    requireRestoredConfigurationValues(state.configOptions, [[id, value]]);
  }
  if (!hooks.current()) return false;
  requireRestoredConfigurationValues(state.configOptions, choices);
  const protectedIds = protectedConfigIds(state.configOptions);
  const mustConfirm = choices.some(([id]) => protectedIds.has(id));
  if (mustConfirm) {
    await hooks.validateService();
    if (!hooks.current()) return false;
    requireRestoredConfigurationValues(state.configOptions, choices);
    await hooks.confirm(saved);
    if (!hooks.current()) return false;
    requireRestoredConfigurationValues(state.configOptions, choices);
  }
  return true;
}

/** A transient operation snapshot, never a saved configuration authority. */
export function captureConfigurationOwner(state: ThreadState) {
  const identity = [
    state.agentId,
    state.cwd,
    state.nativeSessionId,
    state.connectionId,
    state.serviceContext,
  ];
  const service = structuredClone(state.service ?? null);
  return () =>
    sameConfigurationSnapshot(identity, [
      state.agentId,
      state.cwd,
      state.nativeSessionId,
      state.connectionId,
      state.serviceContext,
    ]) && sameConfigurationSnapshot(service, state.service ?? null);
}

function cloneConfirmationValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new ConfigurationConfirmationError("prepare-failed");
  }
}

/** Strict restore/explicit-choice path. Manual confirmation retains its own semantics. */
export async function confirmSavedConfiguration(
  state: ThreadState | undefined,
  selection: Record<string, unknown>,
  hooks: { current(): ThreadState | undefined; emit(): void },
): Promise<void> {
  if (!state?.configCheck)
    throw new ConfigurationConfirmationError("missing-check");
  const busyBefore = configChangeBusyReason(state);
  if (busyBefore)
    throw new ConfigurationConfirmationError("busy-before", busyBefore);
  const saved = cloneConfirmationValue(selection);
  const choices = Object.entries(saved);
  const protectedIds = protectedConfigIds(state.configOptions);
  if (!choices.some(([id]) => protectedIds.has(id)))
    throw new ConfigurationConfirmationError("missing-check");
  requireRestoredConfigurationValues(state.configOptions, choices);
  const initialCheck = state.configCheck;
  let sameOwner: () => boolean;
  try {
    sameOwner = captureConfigurationOwner(state);
  } catch {
    throw new ConfigurationConfirmationError("prepare-failed");
  }
  const current = () => hooks.current() === state && sameOwner();
  state.configuring = true;
  state.configError = null;
  hooks.emit();
  let confirmed = false;
  try {
    const displayed = cloneConfirmationValue(initialCheck.current);
    let reply: ConfigCheck;
    try {
      reply = await invoke<ConfigCheck>("session_confirm_config", {
        agentId: state.agentId,
        cwd: state.cwd,
        sessionId: state.nativeSessionId,
        displayed,
        restoreSelection: saved,
      });
    } catch (error) {
      throw configurationConfirmationRejection(error);
    }
    if (!current()) throw new ConfigurationConfirmationError("owner-changed");
    const busyAfter = configChangeBusyReason({ ...state, configuring: false });
    if (busyAfter)
      throw new ConfigurationConfirmationError("busy-after", busyAfter);
    if (reply?.status !== "ready")
      throw new ConfigurationConfirmationError("reply-not-ready");
    if (state.configCheck?.status !== "ready")
      throw new ConfigurationConfirmationError("state-not-ready");
    if (!sameConfigurationSnapshot(state.configCheck.current, reply.current))
      throw new ConfigurationConfirmationError("snapshot-changed");
    try {
      requireRestoredConfigurationValues(state.configOptions, choices);
    } catch {
      throw new ConfigurationConfirmationError("values-changed");
    }
    // Channel order owns the guard. Never apply a possibly stale ready reply.
    confirmed = true;
  } catch (error) {
    if (current()) state.configError = STRINGS.repair.confirmConfigFailed;
    throw error instanceof ConfigurationConfirmationError
      ? error
      : new ConfigurationConfirmationError("invoke-rejected");
  } finally {
    if (current()) {
      state.configuring = false;
      // A fresh first-message editor has no history or existing work to resume.
      // Only the completed strict confirmation may release its own empty pause.
      if (
        confirmed &&
        state.identity === "draft" &&
        !state.resumed &&
        state.roundItemBase === 0 &&
        state.items.length === 0
      )
        releaseConfigurationPause(state);
      hooks.emit();
    }
  }
}
