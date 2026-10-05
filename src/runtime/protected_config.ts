import {
  hasActiveTools,
  hasPendingRequests,
  type ConfigOptionView,
  type ThreadState,
} from "./session_types";
import { modelConfigOption } from "./session_projection";
import { authActive } from "./auth_activity";
import { authenticationActivity } from "./authentication";

export function isThoughtConfigOption(option: ConfigOptionView): boolean {
  return (
    option.category === "thought_level" ||
    (!option.category &&
      ["thought_level", "reasoning_effort"].includes(option.id))
  );
}

/** The original IDs remain protected when a later declaration changes their category. */
export function protectedConfigIds(
  options: ConfigOptionView[],
  recorded: readonly string[] = [],
): Set<string> {
  const ids = new Set(recorded);
  for (const option of options)
    if (option.category === "model" || isThoughtConfigOption(option))
      ids.add(option.id);
  // Keep the existing category-less model declaration compatibility, without
  // treating new categories such as model_config as model selection.
  const legacy = options.some((option) => option.category === "model")
    ? null
    : modelConfigOption(options.filter((option) => !option.category));
  if (legacy) ids.add(legacy.id);
  return ids;
}

export function configChangeBusy(thread: ThreadState): boolean {
  return Boolean(
    thread.running ||
    thread.submitting ||
    thread.configuring ||
    thread.reconnecting ||
    thread.stopping ||
    thread.stopUnconfirmed ||
    thread.connectionLost ||
    thread.connectionOutcomeUnknown ||
    thread.uncertainPrompt ||
    thread.openError ||
    thread.sourceError ||
    thread.unrecoverable ||
    thread.historyUnavailable ||
    authActive(authenticationActivity(thread.agentId).getSnapshot()) ||
    hasActiveTools(thread) ||
    hasPendingRequests(thread),
  );
}

/** Only currently declared choices may change, after all active work is settled. */
export function configOptionChangeBlocked(
  thread: ThreadState,
  id: string,
): boolean {
  if (configChangeBusy(thread)) return true;
  const option = thread.configOptions.find((option) => option.id === id);
  if (
    !option ||
    !(
      option.type === "boolean" ||
      (option.type === "select" && option.options.length)
    )
  )
    return true;
  const currentIds = protectedConfigIds(thread.configOptions);
  if (
    !protectedConfigIds(
      thread.configOptions,
      thread.configCheck?.protectedIds,
    ).has(id)
  )
    return false;
  return Boolean(
    !currentIds.has(id) ||
    (thread.queued.length && !thread.queuePaused) ||
    thread.modelDrift ||
    (thread.configCheck && thread.configCheck.status !== "ready") ||
    ((thread.identity === "established" || thread.resumed) &&
      !thread.configCheck) ||
    (thread.permissionConfigId && thread.permissionState !== "ready"),
  );
}

export function protectedConfigOptions(
  options: ConfigOptionView[],
  recorded?: readonly string[],
): ConfigOptionView[] {
  const ids = protectedConfigIds(options, recorded);
  return options.filter((option) => ids.has(option.id));
}
