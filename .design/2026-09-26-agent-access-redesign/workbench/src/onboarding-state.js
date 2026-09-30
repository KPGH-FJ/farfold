import {
  agentProgramReady as programReady,
  setupCompletionIssue,
  agentNeedsInitialPreparation,
} from "./agent-setup-state.js";
import {
  accountRequiredForSelection,
  authenticationFolder,
  authenticationRetryAllowed,
} from "./authentication-state.js";
import { preparationEntryKey } from "./setup-entry.js";
import { agentServiceFormats, serviceChoiceIssue } from "./service-access.js";

const steps = ["program", "method", "account", "api", "review"];
const intents = ["existing", "account", "api"];

export function initialOnboardingRecord(agent, draft, state) {
  if (!state || !draft.prepareEntryKey || agent.accessJob?.type === "auth")
    return null;
  if (
    agent.setupDraft?.prepareEntryKey === draft.prepareEntryKey &&
    agent.onboarding?.entryKey === state.entryKey
  )
    return null;
  return { setupDraft: draft, onboarding: state, setupComplete: false };
}

export function usesOnboarding(context = {}, agent) {
  if (
    context.intent === "import" ||
    context.import ||
    context.fixedConversation ||
    (context.view === "thread" && context.intent !== "use")
  )
    return false;
  if (context.resumeOnboarding || agentNeedsInitialPreparation(agent))
    return true;
  if (context.intent === "manage" || context.manage) return false;
  return (
    context.intent === "use" ||
    !["agents", "explore", "thread"].includes(context.view)
  );
}

// A setup draft need not carry an Agent id, but its resume identity must still
// include its source, model, work folder and service revisions.
const entryKey = (agent, selection = {}, context = {}) =>
  preparationEntryKey(
    agent,
    selection.agentId || selection.agent
      ? selection
      : { ...selection, agentId: agent.id },
    context,
  );

export function onboardingInitial(agent, selection = {}, context = {}) {
  if (!usesOnboarding(context, agent)) return null;
  const key = entryKey(agent, selection, context);
  if (context.repair === "account" && accountNeeded(agent, selection))
    return {
      step: programReady(agent) ? "account" : "program",
      intent:
        (selection.accessMode || selection.access) === "api"
          ? "api"
          : "account",
      entryKey: key,
    };
  const saved = agent.onboarding;
  if (
    (saved?.entryKey === key || context.resumeOnboarding) &&
    steps.includes(saved.step) &&
    (saved.intent == null || intents.includes(saved.intent))
  )
    return {
      step: programReady(agent) ? saved.step : "program",
      intent: saved.intent ?? null,
      entryKey: key,
    };
  return {
    step: programReady(agent) ? "method" : "program",
    intent: null,
    entryKey: key,
  };
}

// Account setup is an action within the Agent's own settings, not a third
// persistent model source. This projection never changes the caller's draft.
const sourceSelection = (state, selection = {}) =>
  state.intent === "api"
    ? { ...selection, access: "api", accessMode: "api" }
    : {
        ...selection,
        access: "existing",
        accessMode: "existing",
        serviceId: "",
        sourceId: "",
        serviceSnapshot: undefined,
      };

const accountNeeded = (agent, selection) =>
  (accountRequiredForSelection(agent, selection) ||
    (selection.access === "api" &&
      agent.serviceCapabilities?.requiresAgentAuthentication === true)) &&
  !authenticationRetryAllowed(agent, selection);

const authenticationFinished = (agent, selection) =>
  agent.authentication?.status === "flow-finished" &&
  authenticationFolder(agent.authentication.folder) ===
    authenticationFolder(selection.folder) &&
  authenticationRetryAllowed(agent, selection);

export function onboardingStepIssue(
  state,
  agent,
  selection = {},
  services = [],
) {
  if (!state) return null;
  if (agent.accessJob) return "当前操作尚未结束，请等待或确认结束后继续。";
  if (!programReady(agent)) return "先完成程序连接。";
  const current = sourceSelection(state, selection);
  if (state.step === "method")
    return state.intent ? null : "选择你想使用的方式。";
  if (state.step === "api") {
    if (!current.serviceId && !current.sourceId) return "请选择一个 API 服务。";
    if (!current.model) return "请选择该服务中的模型。";
    return serviceChoiceIssue(current, agent, services);
  }
  if (state.step === "account")
    return authenticationRetryAllowed(agent, current)
      ? null
      : "完成账号设置后继续，或返回选择其他使用方式。";
  if (state.step === "review") {
    if (accountNeeded(agent, current)) return "请先完成当前来源的账号设置。";
    return setupCompletionIssue(agent, current, services);
  }
  return null;
}

export function nextOnboarding(
  state,
  action,
  { agent, selection = {}, services = [], context = {} },
) {
  if (!state || !usesOnboarding(context, agent) || agent.accessJob)
    return state;
  const type = typeof action === "string" ? action : action?.type;
  const move = (step, intent = state.intent) => ({
    step,
    intent,
    entryKey: entryKey(agent, selection, context),
  });
  if (type === "restart")
    return onboardingInitial(
      { ...agent, onboarding: null },
      selection,
      context,
    );
  if (type === "back") {
    const target = {
      method: "program",
      account: state.intent === "api" ? "api" : "method",
      api: "method",
      review: state.intent === "api" ? "api" : "method",
    }[state.step];
    return target ? move(target) : state;
  }
  if (!programReady(agent)) return state;
  if (type === "choose") {
    if (!intents.includes(action.intent) || state.step !== "method")
      return state;
    if (action.intent === "api" && !agentServiceFormats(agent).length)
      return state;
    const chosen = { ...state, intent: action.intent };
    const current = sourceSelection(chosen, selection);
    return move(
      action.intent === "api"
        ? "api"
        : action.intent === "account" || accountNeeded(agent, current)
          ? "account"
          : "review",
      action.intent,
    );
  }
  const current = sourceSelection(state, selection);
  if (type === "repair-account")
    return state.step === "review" && accountNeeded(agent, current)
      ? move("account")
      : state;
  if (type === "repair-api")
    return state.step === "review" &&
      state.intent === "api" &&
      serviceChoiceIssue(current, agent, services)
      ? move("api")
      : state;
  if (type === "after-auth") {
    if (state.step !== "account" || !authenticationFinished(agent, current))
      return state;
    return move(
      state.intent === "api" && serviceChoiceIssue(current, agent, services)
        ? "api"
        : "review",
    );
  }
  if (type !== "next") return state;
  if (state.step === "program")
    return move(
      context.repair === "account" && accountNeeded(agent, current)
        ? "account"
        : "method",
    );
  if (state.step === "method")
    return state.intent
      ? nextOnboarding(
          state,
          { type: "choose", intent: state.intent },
          {
            agent,
            selection,
            services,
            context,
          },
        )
      : state;
  if (onboardingStepIssue(state, agent, selection, services)) return state;
  if (state.step === "api")
    return move(accountNeeded(agent, current) ? "account" : "review");
  if (state.step === "account")
    return move(
      state.intent === "api" && serviceChoiceIssue(current, agent, services)
        ? "api"
        : "review",
    );
  // The caller's existing completion action applies a valid choice to the draft;
  // navigation alone never marks a request, account or Agent as successful.
  return state;
}
