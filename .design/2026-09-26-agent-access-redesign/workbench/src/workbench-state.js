// Design-only transitions. They do not call any Agent or persist product data.
import { usesApi, serviceSourceIdentity } from "./service-access.js";
import { setupTestFingerprint } from "./agent-catalog.js";
import {
  authenticationFolder,
  authenticationRequiredFor,
  authenticationRetryAllowed,
  accountRequiredForSelection,
} from "./authentication-state.js";
import { agentCanAttempt } from "./agent-setup-state.js";
import { entitlementCheckIssue } from "./selection-entitlement.js";
import { FIRST_SEND_AUTH_FAILURES } from "./first-send-auth.js";
export const draftSignature = ({ text, files, folder, choice }) =>
  JSON.stringify({ text, files, folder, choice });

export function canAttempt(agent) {
  return agentCanAttempt(agent);
}

export function hasDraftContent(text = "", files = []) {
  return Boolean(text.trim() || files.length);
}

export function draftTitle(text = "", files = []) {
  return (text.trim() || files[0] || "新对话").slice(0, 30);
}

export function makeAttempt({
  text,
  files,
  folder,
  choice,
  service,
  outcome,
  id,
  permission,
}) {
  const draft = structuredClone({ text, files, folder, choice });
  return {
    id,
    draft,
    signature: draftSignature(draft),
    service: service ? structuredClone(service) : null,
    outcome,
    ...(permission ? { permission: structuredClone(permission) } : {}),
  };
}

export function admittedConversation(attempt) {
  if (["rejected", ...FIRST_SEND_AUTH_FAILURES].includes(attempt.outcome))
    return null;
  const { text, files, folder, choice } = attempt.draft;
  return {
    id: attempt.id,
    title: draftTitle(text, files),
    prompt: text,
    ...choice,
    ...attempt.permission,
    source: attempt.service?.name || choice.source,
    project: folder || "普通对话",
    group: "",
    folder,
    serviceSnapshot: attempt.service,
    draft: "",
    queue: [],
    status: attempt.outcome === "unknown" ? "unknown" : "running",
    unknownReason: attempt.outcome === "unknown" ? "admission" : undefined,
    time: "刚刚",
    simulatePending: attempt.outcome !== "unknown",
    sentAttachments: [...files],
  };
}

export function draftConflicts(current, nextChoice) {
  if (
    !["agentId", "agent", "serviceId", "model"].some(
      (key) => current.choice[key],
    )
  )
    return false;
  return Boolean(
    (current.text.trim() || current.files.length) &&
    (["agent", "agentId", "accessMode", "serviceId", "model", "effort"].some(
      (k) => current.choice[k] !== nextChoice[k],
    ) ||
      serviceSourceIdentity(current.choice.serviceSnapshot) !==
        serviceSourceIdentity(nextChoice.serviceSnapshot)),
  );
}

export function authScopeKey({ choice, folder = "", service }) {
  const api = usesApi(choice);
  return JSON.stringify(
    api
      ? [
          choice.agentId || choice.agent,
          "api",
          service?.id || choice.serviceId,
          service?.secretRevision || 0,
        ]
      : [
          choice.agentId || choice.agent,
          "existing",
          authenticationFolder(folder),
        ],
  );
}

export function rememberAuthFailure(blocks, attempt, previousTestId) {
  const context = { ...attempt.draft, service: attempt.service };
  return { ...blocks, [authScopeKey(context)]: { previousTestId } };
}

export function settleSuccessfulAuthBlock(blocks, attempt) {
  if (attempt?.outcome !== "success" || !attempt.draft?.choice) return blocks;
  const key = authScopeKey({ ...attempt.draft, service: attempt.service });
  if (!blocks[key]) return blocks;
  const next = { ...blocks };
  delete next[key];
  return next;
}

export function scopedAuthIssue(blocks, context, agent) {
  if (agent?.accessJob?.type === "auth")
    return "这个 Agent 的认证操作尚未结束，请等待或确认结束；当前内容已保留。";
  const entitlement = entitlementCheckIssue(
    agent,
    { ...context.choice, folder: context.folder },
    context.service,
  );
  if (entitlement) return entitlement;
  if (
    accountRequiredForSelection(agent || {}, {
      ...context.choice,
      folder: context.folder,
    }) &&
    !authenticationRetryAllowed(agent || {}, {
      ...context.choice,
      folder: context.folder,
    })
  )
    return "此使用方式明确要求 Agent 账号登录，请先完成认证；当前内容已保留。";
  const api = usesApi(context.choice);
  const failure = blocks[authScopeKey(context)];
  if (api)
    return failure
      ? "此 API 服务需要更新密钥，或对原来源重新完成验证。当前内容已保留。"
      : null;
  return (failure || authenticationRequiredFor(agent || {}, context.folder)) &&
    !authenticationRetryAllowed(agent || {}, {
      ...context.choice,
      folder: context.folder,
    })
    ? "这个位置的已有设置仍需重新验证。当前内容已保留。"
    : null;
}

// A new successful test releases only the selected source/context. Completing
// authentication alone does not prove other work locations can send again.
export function releasePreparedAuthFailure(blocks, context, prepared) {
  const key = authScopeKey(context),
    block = blocks[key];
  const result = prepared?.lastAccessResult;
  const evidence = prepared?.setupEvidence || prepared?.setupDraft;
  const api = usesApi(context.choice);
  if (
    !block ||
    result?.type !== "test" ||
    !["passed", "success"].includes(result.status) ||
    !result.id ||
    result.id === block.previousTestId ||
    !result.fingerprint ||
    result.fingerprint !== evidence?.testFingerprint ||
    result.fingerprint !==
      setupTestFingerprint(
        prepared,
        evidence || {},
        context.service ? [context.service] : [],
      ) ||
    prepared.name !== context.choice.agent ||
    authenticationFolder(evidence?.folder) !==
      authenticationFolder(context.folder) ||
    authenticationFolder(result.folder) !==
      authenticationFolder(context.folder) ||
    (evidence?.model || "") !== (context.choice.model || "") ||
    (evidence?.effort || "") !== (context.choice.effort || "") ||
    evidence?.access !== (api ? "api" : "existing") ||
    (api &&
      (evidence.serviceId !==
        (context.service?.id || context.choice.serviceId) ||
        (evidence.secretRevision || 0) !==
          (context.service?.secretRevision || 0)))
  )
    return blocks;
  const next = { ...blocks };
  delete next[key];
  return next;
}

// The visible return page and the task that owns preparation are separate: a
// settings detour must not replace an established task with the global draft.
export function preparationEntry({
  view,
  active,
  tasks,
  draft,
  settingsContext,
}) {
  const owner = view === "settings" && settingsContext ? settingsContext : null;
  const contextView = owner?.contextView || owner?.view || view;
  const contextActive = owner?.contextActive ?? owner?.active ?? active;
  const task =
    contextView === "thread"
      ? tasks.find((item) => item.id === contextActive)
      : null;
  const choice = structuredClone(task || owner?.choice || draft.choice);
  return {
    view,
    active,
    contextView,
    contextActive,
    choice,
    folder: task ? task.folder || "" : (owner?.folder ?? draft.folder),
    signature: owner?.signature || draftSignature(draft),
    agent: choice.agent,
  };
}

export function preparationReturn(entry) {
  return {
    view: entry?.view || "agents",
    ...(entry?.active !== undefined ? { active: entry.active } : {}),
    ...(entry?.intent === "import" && entry.importAgent
      ? { importAgent: entry.importAgent }
      : {}),
  };
}

export function completePreparation(entry, currentDraft, nextChoice) {
  if (
    ["manage", "import"].includes(entry?.intent) ||
    (entry?.intent !== "use" &&
      (!entry || !["new", "new-intent"].includes(entry.view)))
  )
    return {
      destination: preparationReturn(entry),
      draft: currentDraft,
      conflict: false,
      applyChoice: false,
    };
  const original =
    entry?.view === "new" &&
    entry.agent === nextChoice.agent &&
    entry.signature === draftSignature(currentDraft);
  const conflict = !original && draftConflicts(currentDraft, nextChoice);
  return {
    destination: { view: "new" },
    draft: conflict ? currentDraft : { ...currentDraft, choice: nextChoice },
    conflict,
    applyChoice: true,
  };
}
