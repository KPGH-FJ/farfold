import {
  hasActiveWork,
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

export type ConfigBusyReason =
  | "conversationAccess"
  | "running"
  | "submitting"
  | "configuring"
  | "reconnecting"
  | "stopping"
  | "stopUnconfirmed"
  | "connectionLost"
  | "connectionOutcomeUnknown"
  | "uncertainPrompt"
  | "openError"
  | "sourceError"
  | "unrecoverable"
  | "historyUnavailable"
  | "authentication"
  | "activeWork"
  | "pendingRequests";

/** Preserve admission order and short-circuit without retaining private values. */
export function configChangeBusyReason(
  thread: ThreadState,
): ConfigBusyReason | null {
  if (thread.running) return "running";
  if (thread.conversationAccess) return "conversationAccess";
  if (thread.submitting) return "submitting";
  if (thread.configuring) return "configuring";
  if (thread.reconnecting) return "reconnecting";
  if (thread.stopping) return "stopping";
  if (thread.stopUnconfirmed) return "stopUnconfirmed";
  if (thread.connectionLost) return "connectionLost";
  if (thread.connectionOutcomeUnknown) return "connectionOutcomeUnknown";
  if (thread.uncertainPrompt) return "uncertainPrompt";
  if (thread.openError) return "openError";
  if (thread.sourceError) return "sourceError";
  if (thread.unrecoverable) return "unrecoverable";
  if (thread.historyUnavailable) return "historyUnavailable";
  if (authActive(authenticationActivity(thread.agentId).getSnapshot()))
    return "authentication";
  if (hasActiveWork(thread)) return "activeWork";
  if (hasPendingRequests(thread)) return "pendingRequests";
  return null;
}

export function configChangeBusy(thread: ThreadState): boolean {
  return configChangeBusyReason(thread) !== null;
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
