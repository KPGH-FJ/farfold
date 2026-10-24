import { invoke } from "@tauri-apps/api/core";
import { sameConfigurationSnapshot, type ConfigCheck } from "./config_check";
import { configChangeBusy, protectedConfigIds } from "./protected_config";
import { modelConfigOption } from "./session_projection";
import type { ThreadState } from "./session_types";
import { STRINGS } from "./strings";
import {
  requireSavedConfigurationOption,
  requireRestoredConfigurationValues,
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

/** Strict restore/explicit-choice path. Manual confirmation retains its own semantics. */
export async function confirmSavedConfiguration(
  state: ThreadState | undefined,
  selection: Record<string, unknown>,
  hooks: { current(): ThreadState | undefined; emit(): void },
): Promise<void> {
  const failure = () => new Error(STRINGS.repair.confirmConfigFailed);
  if (!state?.configCheck || configChangeBusy(state)) throw failure();
  const saved = structuredClone(selection);
  const choices = Object.entries(saved);
  const protectedIds = protectedConfigIds(state.configOptions);
  if (!choices.some(([id]) => protectedIds.has(id))) throw failure();
  requireRestoredConfigurationValues(state.configOptions, choices);
  const initialCheck = state.configCheck;
  const sameOwner = captureConfigurationOwner(state);
  const current = () => hooks.current() === state && sameOwner();
  state.configuring = true;
  state.configError = null;
  hooks.emit();
  try {
    const reply = await invoke<ConfigCheck>("session_confirm_config", {
      agentId: state.agentId,
      cwd: state.cwd,
      sessionId: state.nativeSessionId,
      displayed: structuredClone(initialCheck.current),
      restoreSelection: saved,
    });
    if (
      !current() ||
      configChangeBusy({ ...state, configuring: false }) ||
      reply?.status !== "ready" ||
      state.configCheck?.status !== "ready" ||
      !sameConfigurationSnapshot(state.configCheck.current, reply.current)
    )
      throw failure();
    requireRestoredConfigurationValues(state.configOptions, choices);
    // Channel order owns the guard. Never apply a possibly stale ready reply.
  } catch {
    if (current()) state.configError = STRINGS.repair.confirmConfigFailed;
    throw failure();
  } finally {
    if (current()) {
      state.configuring = false;
      hooks.emit();
    }
  }
}
