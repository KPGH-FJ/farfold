import {
  availableAuthMethods,
  authenticationFolder,
  authenticationStartIssue,
} from "./authentication-state.js";
import { startAgentJob } from "./access-jobs.js";
import { serviceSourceIdentity } from "./service-access.js";

const registrationSelectionIdentity = (selection = {}) => {
  const access =
    selection.access ||
    selection.accessMode ||
    (selection.serviceId || selection.sourceId ? "api" : "existing");
  const source = selection.serviceSnapshot || {};
  return JSON.stringify([
    authenticationFolder(selection.folder),
    access,
    access === "api" ? selection.serviceId || selection.sourceId || "" : "",
    selection.model || "",
    selection.effort || "",
    access === "api"
      ? [
          serviceSourceIdentity(source),
          source.revision || 0,
          selection.secretRevision ?? source.secretRevision ?? 0,
        ]
      : null,
  ]);
};

export const registrationSelectionChanged = (registration, selection) =>
  registrationSelectionIdentity(registration?.selection) !==
  registrationSelectionIdentity(selection);

// The registration result is never an authentication result. Resume the exact
// declared method and the original preparation choice, or ask the user to choose.
export function registrationLoginIssue(agent, registration, options = {}) {
  if (!registration || registration.kind === "api")
    return "请回到账号准备页选择登录方式。";
  const method = availableAuthMethods(agent).find(
    (item) => item.id === registration.methodId,
  );
  if (!method)
    return "原登录方式已不可用。注册进度保留，请返回重新选择登录方式。";
  const current = options.selection || registration.selection || {};
  if (registrationSelectionChanged(registration, current))
    return "本次准备的选择已改变。请返回准备页，按当前选择登录。";
  return authenticationStartIssue(agent, method, options.busyCount);
}

export function continueRegistrationLogin(agent, registration, options = {}) {
  if (registrationLoginIssue(agent, registration, options)) return agent;
  const method = availableAuthMethods(agent).find(
    (item) => item.id === registration.methodId,
  );
  const next = startAgentJob(
    {
      ...agent,
      registration: { ...registration, open: false },
      authMethodSelection: method.id,
    },
    "auth",
    {
      ...options,
      authMethod: method,
      selection: registration.selection,
    },
  );
  if (!next.accessJob || next.accessJob.type !== "auth") return agent;
  return {
    ...next,
    registration: { ...next.registration, loginJobId: next.accessJob.id },
  };
}

// Called only after the user explicitly adopts the current preparation choice.
// Registration facts survive; a previous login receipt cannot cover this choice.
export function rebaseRegistrationSelection(agent, registration, options = {}) {
  if (
    !registration ||
    registration.kind === "api" ||
    !options.selection ||
    typeof options.selection !== "object" ||
    Array.isArray(options.selection)
  )
    return agent;
  const method = availableAuthMethods(agent).find(
    (item) => item.id === registration.methodId,
  );
  if (!method || authenticationStartIssue(agent, method, options.busyCount))
    return agent;
  const nextRegistration = {
    ...registration,
    selection: structuredClone(options.selection),
  };
  delete nextRegistration.loginJobId;
  return { ...agent, registration: nextRegistration };
}

export function registrationMatchesService(registration, draft) {
  return (
    registration?.kind === "api" &&
    registration.accountLabel ===
      (draft.provider?.trim() || "你选择的 API 服务") &&
    ["endpoint", "format"].every(
      (key) => (registration.selection?.[key] || "") === (draft[key] || ""),
    )
  );
}

export function registrationLoginFinished(agent, registration) {
  const folder = (value) => (value === "普通对话" ? "" : value || "");
  return (
    !!registration?.loginJobId &&
    agent.authentication?.jobId === registration.loginJobId &&
    agent.authentication?.status === "flow-finished" &&
    agent.authentication.method === registration.methodId &&
    folder(agent.authentication.folder) ===
      folder(registration.selection?.folder)
  );
}
