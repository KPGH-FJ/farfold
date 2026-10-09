import { initialSetupDraft, setupFingerprint } from "./agent-setup-state.js";
import { serviceSourceIdentity } from "./service-access.js";

export function selectionMatchesAgent(agent, selection) {
  return (
    !!selection &&
    (selection.agentId
      ? selection.agentId === agent.id
      : [agent.id, agent.name].includes(selection.agent))
  );
}
export function preparationEntryKey(agent, selection, context = {}) {
  const access =
    selection?.accessMode ||
    selection?.access ||
    (selection?.serviceId || selection?.sourceId ? "api" : "existing");
  const source = selection?.serviceSnapshot || {};
  return JSON.stringify([
    agent.id,
    context.view || "explore",
    context.active || "",
    context.repair || "",
    context.folder ?? selection?.folder ?? "",
    selectionMatchesAgent(agent, selection)
      ? [
          access,
          access === "api"
            ? selection.serviceId || selection.sourceId || ""
            : "",
          selection.model || "",
          selection.effort || "",
          access === "api"
            ? [
                serviceSourceIdentity(source),
                source.revision || 0,
                selection.secretRevision ?? source.secretRevision ?? 0,
              ]
            : null,
        ]
      : null,
  ]);
}

// A return page does not own a new preparation. Explicit use always prepares
// the current unsent draft, while manage keeps an established conversation.
export function preparationIntentEntry(entry, intent, draft) {
  const next = { ...entry, view: entry?.view || "agents", intent };
  if (intent !== "use") return next;
  const { text = "", files = [], folder = "", choice = {} } = draft || {};
  return {
    ...next,
    contextView: "new",
    contextActive: null,
    choice: structuredClone(choice),
    folder,
    agent: choice.agent,
    signature: JSON.stringify({ text, files, folder, choice }),
    repair: undefined,
    panel: undefined,
    reason: undefined,
  };
}

export const hasPendingOnboarding = (agent) =>
  !agent.setupComplete &&
  ["program", "method", "account", "api", "review"].includes(
    agent.onboarding?.step,
  ) &&
  (agent.onboarding.intent == null ||
    ["existing", "account", "api"].includes(agent.onboarding.intent));

export function preservePendingPreparation(changes, owner) {
  if (!owner || !hasPendingOnboarding(owner)) return changes;
  return {
    ...changes,
    setupDraft: structuredClone(owner.setupDraft),
    onboarding: structuredClone(owner.onboarding),
    setupComplete: owner.setupComplete,
    onboardingComplete:
      owner.onboardingComplete ?? owner.setupComplete === true,
    setupEvidence: structuredClone(owner.setupEvidence),
  };
}

export function pendingOnboardingForEntry(agent, selection, context = {}) {
  if (
    !hasPendingOnboarding(agent) ||
    context.intent === "import" ||
    context.import ||
    context.fixedConversation ||
    (context.view === "thread" && context.intent !== "use")
  )
    return null;
  let key;
  try {
    key = JSON.parse(agent.setupDraft?.prepareEntryKey);
  } catch {
    return null;
  }
  if (
    !Array.isArray(key) ||
    key.length !== 6 ||
    key[0] !== agent.id ||
    !["new", "agents", "explore"].includes(key[1])
  )
    return null;
  const owner = {
    ...context,
    view: key[1],
    active: key[2] || undefined,
    repair: key[3] || undefined,
  };
  if (
    preparationEntryKey(agent, selection, owner) !==
    agent.setupDraft.prepareEntryKey
  )
    return null;
  return {
    ...owner,
    intent: "use",
    repair: context.repair || owner.repair,
    resumePreparationKey: agent.setupDraft.prepareEntryKey,
    resumeOnboarding: true,
  };
}
export function draftForEntry(agent, services, selection, context = {}) {
  const saved = initialSetupDraft(agent, services);
  if (agent.accessJob?.type === "auth")
    return {
      ...saved,
      ...structuredClone(agent.accessJob.selection),
      test: "idle",
      testFingerprint: null,
    };
  const entryKey = preparationEntryKey(agent, selection, context);
  const folder = context.folder ?? selection?.folder ?? "";
  // A suspended preparation belongs to its entry, not to the last committed draft.
  if (
    saved.prepareEntryKey === entryKey ||
    (context.resumePreparationKey &&
      saved.prepareEntryKey === context.resumePreparationKey)
  )
    return saved;
  if (
    agent.setupDraft &&
    !saved.prepareEntryKey &&
    !selectionMatchesAgent(agent, selection) &&
    saved.folder === folder
  )
    return { ...saved, prepareEntryKey: entryKey };
  let next = {
    ...initialSetupDraft({ ...agent, setupDraft: undefined }, services),
    folder,
    prepareEntryKey: entryKey,
  };
  if (selectionMatchesAgent(agent, selection)) {
    const access = selection.accessMode
      ? selection.accessMode === "api"
        ? "api"
        : "existing"
      : selection.serviceId || selection.sourceId
        ? "api"
        : "existing";
    next = {
      ...next,
      access,
      serviceId:
        access === "api"
          ? (selection.serviceId ?? selection.sourceId ?? "")
          : "",
      serviceSnapshot:
        access === "api"
          ? structuredClone(selection.serviceSnapshot || null)
          : null,
      model: selection.model ?? saved.model,
      effort: selection.effort ?? saved.effort,
      configValues: structuredClone(selection.configValues || {}),
    };
  }
  return setupFingerprint(agent, next, services) === saved.testFingerprint
    ? next
    : { ...next, test: "idle", testFingerprint: null };
}
