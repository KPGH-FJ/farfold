// Presentation state only. Authentication never creates another model source.
export const availableAuthMethods = (agent) =>
  [
    ...(agent.authMethods || []),
    ...(agent.manualAuthentication ? [agent.manualAuthentication] : []),
  ].filter((method) => ["agent", "terminal"].includes(method.type));
export function resolvedAuthenticationMethod(agent, method) {
  if (!method?.id) return null;
  if (method.manual) {
    if (
      !Array.isArray(method.args) ||
      method.args.some((arg) => typeof arg !== "string")
    )
      return null;
    return manualAuthenticationMethod(
      method.command || "",
      method.args.join("\n"),
      method.secretVariable || "",
    );
  }
  const declared = availableAuthMethods(agent).find(
    (item) => item.id === method.id,
  );
  return declared && (!method.type || method.type === declared.type)
    ? { ...declared }
    : null;
}
export function authenticationStartIssue(agent, method, busyCount = 0) {
  if (
    !agent?.installed ||
    agent.removed ||
    agent.registered === false ||
    agent.added === false
  )
    return "先添加并准备这个 Agent，再开始认证。";
  if (agent.dependenciesMissing) return "先补齐运行所需的程序，再开始认证。";
  if (
    !agent.connected ||
    (agent.connectionState && agent.connectionState !== "connected")
  )
    return "先连接这个 Agent，再使用它提供的认证方式。";
  if (agent.accessJob) return "当前操作尚未结束，请等待或确认结束后再认证。";
  if (busyCount)
    return "这个 Agent 仍有未结束的工作，请回到对应对话处理后再登录。";
  if (!resolvedAuthenticationMethod(agent, method))
    return "选择这个 Agent 声明的认证方式，或明确配置有效的登录命令。";
  return null;
}
export const authenticationFolder = (folder) =>
  folder === "普通对话" ? "" : (folder ?? "");
export function authenticationRequiredContexts(agent) {
  return [
    ...new Set([
      ...(agent.authRequiredContexts || []).map(authenticationFolder),
      ...(agent.authRequired
        ? [authenticationFolder(agent.authRequiredContext)]
        : []),
    ]),
  ];
}
export const authenticationRequiredFor = (agent, folder) =>
  authenticationRequiredContexts(agent).includes(authenticationFolder(folder));
const selectionUsesApi = (selection = {}) =>
  (selection.access ||
    selection.accessMode ||
    (selection.serviceId ? "api" : "existing")) === "api";
const apiAuthenticationScope = (selection = {}) =>
  JSON.stringify([
    authenticationFolder(selection.folder),
    selection.serviceId || selection.sourceId || "",
  ]);
export function accountRequiredForSelection(agent, selection = {}) {
  const api = selectionUsesApi(selection);
  return (
    (api &&
      (agent.authRequiredApiSelections || []).includes(
        apiAuthenticationScope(selection),
      )) ||
    ((!api ||
      agent?.serviceCapabilities?.requiresAgentAuthentication === true) &&
      authenticationRequiredFor(agent, selection.folder))
  );
}
// A returned Agent-level failure is an observation for this choice, not a new
// capability declaration or evidence that the selected service key is invalid.
export function rememberAgentAuthenticationRequirement(agent, selection = {}) {
  if (!selectionUsesApi(selection))
    return rememberAuthenticationRequirement(agent, selection.folder);
  return {
    ...agent,
    authRequiredApiSelections: [
      ...new Set([
        ...(agent.authRequiredApiSelections || []),
        apiAuthenticationScope(selection),
      ]),
    ],
    ...authenticationRetryRevocation(agent, selection),
  };
}
export function clearAgentAuthenticationRequirement(agent, selection = {}) {
  const api = selectionUsesApi(selection);
  const next =
    !api || agent.serviceCapabilities?.requiresAgentAuthentication === true
      ? clearAuthenticationRequirement(agent, selection.folder)
      : agent;
  if (!api) return next;
  return {
    ...next,
    ...authenticationRetryRevocation(next, selection),
    authRequiredApiSelections: (next.authRequiredApiSelections || []).filter(
      (scope) => scope !== apiAuthenticationScope(selection),
    ),
  };
}
const retrySelection = (agent, selection) =>
  typeof selection === "string" || selection == null
    ? {
        ...(agent.setupDraft?.access === "existing" ? agent.setupDraft : {}),
        access: "existing",
        folder: selection || "",
        model:
          agent.setupDraft?.access === "existing"
            ? agent.setupDraft.model
            : agent.model,
        effort:
          agent.setupDraft?.access === "existing"
            ? agent.setupDraft.effort
            : agent.effort,
      }
    : selection;
export function authenticationRetryScope(agent, input = {}) {
  const selection = retrySelection(agent, input);
  const api = selectionUsesApi(selection);
  const source = selection.serviceSnapshot || {};
  return JSON.stringify([
    authenticationFolder(selection.folder),
    api ? "api" : "existing",
    api ? selection.serviceId || selection.sourceId || "" : "",
    api ? source.endpoint || "" : "",
    api ? source.format || "" : "",
    api ? source.revision || 0 : 0,
    api ? (selection.secretRevision ?? source.secretRevision ?? 0) : 0,
    selection.model ?? agent.model ?? "",
    selection.effort ?? agent.effort ?? "",
    agent.selectedInstallationId || "",
    agent.programRevision || 0,
  ]);
}
// Old folder-only grants lack source identity. They can only describe the
// explicitly retained local choice, never an API selection or a changed model.
export function authenticationRetryAllowed(agent, input) {
  const selection = retrySelection(agent, input);
  const key = authenticationRetryScope(agent, selection);
  if ((agent.authenticationRetrySelections || []).includes(key)) return true;
  const saved = agent.setupDraft;
  return !!(
    saved &&
    !selectionUsesApi(saved) &&
    !selectionUsesApi(selection) &&
    (agent.authenticationRetryContexts || []).includes(
      authenticationFolder(selection.folder),
    ) &&
    key ===
      authenticationRetryScope(agent, {
        ...saved,
        access: "existing",
        folder: selection.folder,
      })
  );
}
export function authenticationRetryRevocation(agent, input) {
  const selection = retrySelection(agent, input);
  const target = JSON.parse(authenticationRetryScope(agent, selection));
  return {
    authenticationRetryContexts: (
      agent.authenticationRetryContexts || []
    ).filter((folder) => authenticationFolder(folder) !== target[0]),
    authenticationRetrySelections: (
      agent.authenticationRetrySelections || []
    ).filter((key) => {
      try {
        const scope = JSON.parse(key);
        return !target
          .slice(0, 3)
          .every((value, index) => scope[index] === value);
      } catch {
        return false;
      }
    }),
  };
}
export function invalidateAuthenticationEvidence(agent) {
  return {
    ...agent,
    setupComplete: false,
    demoReady: false,
    setupEvidence: null,
    setupDraft: { ...agent.setupDraft, test: "idle", testFingerprint: null },
  };
}
export function rememberAuthenticationRequirement(agent, folder) {
  const context = authenticationFolder(folder);
  return {
    ...agent,
    authRequired: true,
    authRequiredContext: context,
    authRequiredContexts: [
      ...new Set([...authenticationRequiredContexts(agent), context]),
    ],
    ...authenticationRetryRevocation(agent, {
      access: "existing",
      folder: context,
    }),
  };
}
export function markAuthenticationForRetry(agent, input) {
  if (agent.accessJob) return agent;
  const selection = retrySelection(agent, input);
  const context = authenticationFolder(selection.folder);
  return {
    ...invalidateAuthenticationEvidence(agent),
    authenticationRetryContexts: (
      agent.authenticationRetryContexts || []
    ).filter((folder) => authenticationFolder(folder) !== context),
    authenticationRetrySelections: [
      ...new Set([
        ...(agent.authenticationRetrySelections || []),
        authenticationRetryScope(agent, selection),
      ]),
    ],
    authentication: {
      status: "needs-check",
      folder: context,
      entitlement: "unknown",
    },
  };
}
export function clearAuthenticationRequirement(agent, folder) {
  const context = authenticationFolder(folder);
  const remaining = authenticationRequiredContexts(agent).filter(
    (item) => item !== context,
  );
  return {
    ...agent,
    authRequired: remaining.length > 0,
    authRequiredContext: remaining.at(-1),
    authRequiredContexts: remaining,
    ...authenticationRetryRevocation(agent, {
      access: "existing",
      folder: context,
    }),
  };
}
export function manualAuthenticationIssue(command, args = "", variable = "") {
  if (!command.trim() || /[\r\n\0;&|`$<>]/.test(command))
    return "填写单个登录程序路径或命令；参数单独逐行填写。";
  if (/\0/.test(args)) return "参数不能包含无效字符。";
  if (
    /(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[=:]\s*\S+)/i.test(
      `${command}\n${args}`,
    )
  )
    return "这里不接收密钥或密码，请只填写演示命令和普通参数。";
  if (variable && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
    return "只填写密钥变量名称，不填写值。";
  return null;
}
export function manualAuthenticationMethod(command, args = "", variable = "") {
  if (manualAuthenticationIssue(command, args, variable)) return null;
  return {
    id: "manual-explicit",
    type: "terminal",
    presentation: "terminal",
    label: "自定义登录",
    manual: true,
    command: command.trim(),
    args: args
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    ...(variable ? { secretVariable: variable } : {}),
  };
}
