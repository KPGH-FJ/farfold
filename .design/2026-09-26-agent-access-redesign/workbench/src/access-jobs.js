import { normalizeAgent } from "./agent-setup-state.js";
import { canFinishOfficialHandoff } from "./official-handoff-state.js";
import {
  authenticationFolder,
  accountRequiredForSelection,
  authenticationRetryAllowed,
  authenticationRetryRevocation,
  authenticationStartIssue,
  resolvedAuthenticationMethod,
  clearAgentAuthenticationRequirement,
  invalidateAuthenticationEvidence,
  markAuthenticationForRetry,
  rememberAgentAuthenticationRequirement,
} from "./authentication-state.js";
import {
  entitlementCheckIssue,
  rememberEntitlementFailure,
  clearEntitlementFailure,
  markEntitlementForRetry,
} from "./selection-entitlement.js";

const stages = {
  install: ["准备候选程序", "检查连接兼容性", "确认检查已结束", "选用新程序"],
  dependency: ["准备必要程序", "检查必要程序", "确认检查已结束"],
  select: ["检查所选程序", "检查连接兼容性", "确认检查已结束", "选用所选程序"],
  connect: ["启动已选程序", "检查连接能力"],
  test: ["发送固定短句", "等待 Agent 回复", "确认请求已结束"],
  auth: ["等待登录授权", "确认登录操作已结束", "重新检查连接"],
};
let sequence = 0;
export function startAgentJob(input, type, options = {}, now = Date.now()) {
  let agent = normalizeAgent(input);
  if (
    type === "auth" &&
    authenticationStartIssue(agent, options.authMethod, options.busyCount)
  )
    return input;
  const authMethod =
    type === "auth"
      ? resolvedAuthenticationMethod(agent, options.authMethod)
      : null;
  // A short test uses its own request; unrelated conversations need no reconnect.
  if (
    !stages[type] ||
    agent.accessJob ||
    (type !== "test" && options.busyCount)
  )
    return input;
  if (["install", "select", "dependency"].includes(type) && agent.connected)
    return input;
  if (
    ["test", "auth", "connect"].includes(type) &&
    (!agent.installed || agent.dependenciesMissing || agent.removed)
  )
    return input;
  if (type === "test" && !agent.connected) return input;
  if (
    type === "select" &&
    !agent.installations.some((item) => item.id === options.candidateId)
  )
    return input;
  const selection = structuredClone({
    ...agent.setupDraft,
    ...options.selection,
    folder: authenticationFolder(
      options.selection?.folder ?? agent.setupDraft?.folder,
    ),
  });
  if (type === "test" && entitlementCheckIssue(agent, selection)) return input;
  if (
    type === "test" &&
    accountRequiredForSelection(agent, selection) &&
    !authenticationRetryAllowed(agent, selection)
  )
    return input;
  if (type === "auth")
    agent = {
      ...invalidateAuthenticationEvidence(agent),
      authentication: undefined,
      ...authenticationRetryRevocation(agent, selection),
      ...(authMethod?.manual ? { manualAuthentication: authMethod } : {}),
    };
  const id = `${agent.id}-${now}-${++sequence}`;
  const candidate =
    type === "install"
      ? {
          id,
          path: `~/Library/Application Support/Farfold/agents/${agent.id}/${id}`,
          version: "模拟候选",
          componentVersion: agent.componentVersion || "",
          managed: true,
        }
      : null;
  return {
    ...agent,
    lastAccessResult: null,
    ...(type === "connect"
      ? { connected: false, connectionState: "connecting" }
      : {}),
    ...(type === "test"
      ? {
          setupDraft: {
            ...agent.setupDraft,
            test: "running",
            testFingerprint: options.fingerprint,
          },
        }
      : {}),
    accessJob: {
      id,
      type,
      status: type === "auth" ? "waiting" : "running",
      stage: 0,
      label: stages[type][0],
      dueAt: now + 700,
      outcome: options.outcome || "success",
      authenticationLayer: options.authenticationLayer,
      cancelOutcome: options.cancelOutcome || "success",
      candidate,
      candidateId: options.candidateId,
      fingerprint: options.fingerprint,
      selection,
      authMethod,
      previousConnection: agent.connectionState,
      previousSelected: agent.selectedInstallationId,
      startedAt: now,
      expiresAt:
        type === "auth" &&
        Number.isFinite(authMethod?.expiresInMs) &&
        authMethod.expiresInMs > 0
          ? now + authMethod.expiresInMs
          : undefined,
    },
  };
}
function stopResult(agent, status, message) {
  const job = agent.accessJob;
  return {
    ...agent,
    accessJob: null,
    lastAccessResult: {
      type: job.type,
      status,
      message,
      id: job.id,
      fingerprint: job.fingerprint,
      folder: job.selection?.folder,
    },
    ...(job.type === "connect"
      ? {
          connected: false,
          connectionState: status === "failed" ? "failed" : "idle",
        }
      : {}),
    ...(job.type === "test"
      ? {
          setupDraft: {
            ...agent.setupDraft,
            test: status,
            testFingerprint: null,
          },
        }
      : {}),
  };
}
export function cancelAgentJob(agent, now = Date.now()) {
  const job = agent.accessJob;
  if (!job || ["cancelling", "unknown"].includes(job.status)) return agent;
  return {
    ...agent,
    accessJob: {
      ...job,
      status: "cancelling",
      label: "正在取消，等待结束确认",
      dueAt: now + 700,
    },
  };
}
// This only refreshes progress already held here. It does not poll an Agent,
// synthesize a receipt, or begin another authentication attempt.
export function checkAuthenticationJob(agent, id, now = Date.now()) {
  const job = agent.accessJob;
  if (job?.id !== id || job.type !== "auth" || job.status !== "unknown")
    return agent;
  return {
    ...agent,
    accessJob: {
      ...job,
      lastResultCheckAt: now,
      resultCheckNotice: "尚未收到新的登录结果。可以继续等待，或结束此次登录。",
    },
  };
}
// Request the retained operation to end; only its later confirmation releases
// the operation. An unknown cancellation result must retain its ID and choices.
export function endAuthenticationJob(agent, id, now = Date.now()) {
  const job = agent.accessJob;
  if (job?.id !== id || job.type !== "auth" || job.status !== "unknown")
    return agent;
  return {
    ...agent,
    accessJob: {
      ...job,
      status: "cancelling",
      label: "正在结束此次登录，等待确认",
      resultCheckNotice: undefined,
      waitNotice: false,
      dueAt: now + 700,
    },
  };
}
// Explicit simulation control, not a production assertion that a process exited.
export function confirmAgentJobStopped(agent, id) {
  if (
    agent.accessJob?.id !== id ||
    !["unknown", "cancelling", "approval"].includes(agent.accessJob.status)
  )
    return agent;
  return stopResult(agent, "cancelled", "模拟结束已确认；程序选择和输入保留。");
}
export function continueAgentJob(agent, id, now = Date.now()) {
  if (
    agent.accessJob?.id !== id ||
    !["waiting", "approval"].includes(agent.accessJob.status)
  )
    return agent;
  if (
    agent.accessJob.officialHandoff &&
    ["success", "approval"].includes(agent.accessJob.outcome) &&
    !canFinishOfficialHandoff(agent.accessJob.officialHandoff)
  )
    return agent;
  if (
    agent.accessJob.status === "waiting" &&
    Number.isFinite(agent.accessJob.expiresAt) &&
    now >= agent.accessJob.expiresAt
  )
    return {
      ...agent,
      accessJob: {
        ...agent.accessJob,
        status: "unknown",
        label: "登录等待已过期，结束仍待确认",
      },
    };
  return {
    ...agent,
    accessJob: {
      ...agent.accessJob,
      status: "running",
      waitNotice: false,
      stage: agent.accessJob.type === "auth" ? 1 : agent.accessJob.stage,
      outcome:
        agent.accessJob.outcome === "approval"
          ? "success"
          : agent.accessJob.outcome,
      label:
        agent.accessJob.type === "auth"
          ? agent.accessJob.accountRoutePurpose === "service"
            ? "确认设置操作已结束"
            : stages.auth[1]
          : "继续检查",
      dueAt: now + 700,
    },
  };
}
// A late official result belongs to the retained operation. Unknown is not a
// failed login and cannot unlock a second authentication attempt.
export function resolveAuthenticationJob(agent, id, now = Date.now()) {
  const job = agent.accessJob;
  if (
    job?.id !== id ||
    job.type !== "auth" ||
    !["waiting", "unknown", "cancelling"].includes(job.status)
  )
    return agent;
  if (job.officialHandoff && !canFinishOfficialHandoff(job.officialHandoff))
    return agent;
  return {
    ...agent,
    accessJob: {
      ...job,
      status: "running",
      waitNotice: false,
      resultCheckNotice: undefined,
      stage: 1,
      outcome: "success",
      label: "已收到登录结果，确认操作已结束",
      dueAt: now + 700,
      expiresAt: undefined,
    },
  };
}
function successful(agent) {
  const job = agent.accessJob;
  let next = stopResult(agent, "passed", "模拟操作已完成。");
  if (["install", "select"].includes(job.type)) {
    const installations = job.candidate
      ? [...agent.installations, job.candidate]
      : agent.installations;
    const selected = installations.find(
      (item) => item.id === (job.candidate?.id || job.candidateId),
    );
    next = {
      ...next,
      installations,
      selectedInstallationId: selected.id,
      installed: true,
      available: true,
      added: true,
      registered: true,
      removed: false,
      version: selected.version,
      programRevision: agent.programRevision + 1,
      connected: false,
      connectionState: "idle",
      setupComplete: false,
      setupDraft: { ...agent.setupDraft, test: "idle", testFingerprint: null },
    };
  } else if (job.type === "dependency")
    next = { ...next, dependenciesMissing: false };
  else if (["connect", "auth"].includes(job.type))
    next = {
      ...next,
      connected: true,
      connectionState: "connected",
      connectionRevision: agent.connectionRevision + 1,
      ...(job.type === "connect" ? { added: true, registered: true } : {}),
      ...(job.type === "auth"
        ? {
            authentication: {
              jobId: job.id,
              method: job.authMethod?.id,
              status:
                job.officialHandoff?.mode === "service"
                  ? "external-returned"
                  : "flow-finished",
              folder: job.selection.folder,
              entitlement: "unknown",
              accountService: job.officialHandoff
                ? job.officialHandoff.mode === "account"
                  ? job.officialHandoff.account
                  : null
                : job.authMethod?.accountLabel || null,
              accountKind: job.officialHandoff
                ? job.officialHandoff.mode === "account"
                  ? "account"
                  : null
                : "account",
              demo: true,
            },
          }
        : {}),
      setupComplete: false,
      setupDraft: { ...agent.setupDraft, test: "idle", testFingerprint: null },
    };
  else if (job.type === "test")
    next = {
      ...next,
      setupDraft: {
        ...agent.setupDraft,
        test: "passed",
        testFingerprint: job.fingerprint,
      },
      setupEvidence: {
        ...job.selection,
        test: "passed",
        testFingerprint: job.fingerprint,
      },
    };
  if (job.type === "auth") {
    next = {
      ...markEntitlementForRetry(
        markAuthenticationForRetry(next, job.selection),
        job.selection,
      ),
      authentication: next.authentication,
      lastAccessResult: {
        ...next.lastAccessResult,
        message:
          job.officialHandoff?.mode === "service" ||
          job.accountRoutePurpose === "service"
            ? "已返回服务设置，账号和模型可用性仍待检查。"
            : "登录步骤已结束，模型可用性仍待检查。",
      },
    };
  } else if (job.type === "test") {
    next = clearEntitlementFailure(next, job.selection);
    next = clearAgentAuthenticationRequirement(next, job.selection);
  }
  return next;
}

export function authenticationFailureLayer(job) {
  if (job.outcome === "agent_auth_required") return "agent";
  if (job.outcome === "service_auth_required") return "service";
  if (job.outcome === "authentication_unknown") return "unknown";
  if (job.outcome !== "auth_required") return null;
  // Legacy review fixtures used auth_required for Agent authentication. An API
  // choice alone cannot establish where an authentication error originated.
  return ["agent", "service", "unknown"].includes(job.authenticationLayer)
    ? job.authenticationLayer
    : "agent";
}

function authenticationFailure(agent, observedLayer) {
  const job = agent.accessJob;
  const serviceId = job.selection?.serviceId;
  const storedServiceSelected =
    (job.selection?.access || job.selection?.accessMode) === "api" && serviceId;
  const layer =
    observedLayer === "service" && !storedServiceSelected
      ? "unknown"
      : observedLayer;
  const messages = {
    agent: "这个 Agent 明确要求登录。原任务不会自动重发。",
    service: "所选 API 服务认证失败，请检查该服务的密钥。原任务不会自动重发。",
    unknown:
      "请求因认证问题未完成，但无法确认需要登录账号还是更新服务密钥。请查看本次结果后再重试。",
  };
  let next = stopResult(agent, "failed", messages[layer]);
  next.lastAccessResult = {
    ...next.lastAccessResult,
    authenticationLayer: layer,
  };
  if (layer === "agent")
    return rememberAgentAuthenticationRequirement(next, job.selection);
  if (layer !== "service") return next;
  return {
    ...next,
    serviceAuthIssues: [
      ...(agent.serviceAuthIssues || []).filter(
        (issue) =>
          issue.serviceId !== serviceId ||
          issue.secretRevision !== (job.selection.secretRevision || 0),
      ),
      { serviceId, secretRevision: job.selection.secretRevision || 0 },
    ],
  };
}
export function advanceAgentJobs(agents, now = Date.now()) {
  let changed = false;
  const result = agents.map((input) => {
    const job = input.accessJob;
    if (!job || ["unknown", "approval"].includes(job.status)) return input;
    if (job.status === "waiting") {
      if (!Number.isFinite(job.expiresAt) || now < job.expiresAt) return input;
      changed = true;
      return {
        ...input,
        accessJob: {
          ...job,
          status: "unknown",
          label: "登录等待已过期，结束仍待确认",
        },
      };
    }
    if (now < job.dueAt) return input;
    changed = true;
    const agent = normalizeAgent(input);
    if (job.status === "cancelling")
      return job.cancelOutcome === "unknown"
        ? {
            ...agent,
            accessJob: {
              ...job,
              status: "unknown",
              label: "结束尚未确认，保留当前选择",
            },
          }
        : stopResult(agent, "cancelled", "取消已确认；原程序和输入保留。");
    if (job.stage >= 1 && job.outcome !== "success") {
      if (job.outcome === "unknown")
        return {
          ...agent,
          accessJob: { ...job, status: "unknown", label: "操作结果尚未确认" },
        };
      if (job.outcome === "approval")
        return {
          ...agent,
          accessJob: { ...job, status: "approval", label: "等待本次操作确认" },
        };
      const authenticationLayer = authenticationFailureLayer(job);
      if (authenticationLayer)
        return authenticationFailure(agent, authenticationLayer);
      if (job.outcome === "entitlement")
        return rememberEntitlementFailure(
          stopResult(
            agent,
            "failed",
            "这次请求没有可用权限或额度。请查看服务方说明。",
          ),
          job.selection,
        );
      return stopResult(
        agent,
        "failed",
        (job.type === "auth" && job.failureMessage?.trim()) ||
          "模拟操作失败；原程序选择、历史和输入均保留。",
      );
    }
    if (job.stage + 1 >= stages[job.type].length) return successful(agent);
    return {
      ...agent,
      accessJob: {
        ...job,
        stage: job.stage + 1,
        label: stages[job.type][job.stage + 1],
        dueAt: now + 700,
      },
    };
  });
  return changed ? result : agents;
}
function pathContains(root, path) {
  if (typeof path !== "string") return false;
  const clean = (value) => {
    const segments = [];
    for (const segment of value.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    return `${value.startsWith("/") ? "/" : ""}${segments.join("/")}`;
  };
  const base = clean(root),
    candidate = clean(path);
  return candidate === base || candidate.startsWith(`${base}/`);
}
export function installationReferenceIssue(agent, item, allAgents = []) {
  if (!item?.managed) return null;
  const root = item.managedRoot || item.path;
  if (!root) return "无法确认这份程序的归属路径。";
  const user = allAgents.find(
    (other) =>
      other.id !== agent.id &&
      !other.removed &&
      (other.registered || other.added || other.installed || other.connected) &&
      [
        other.command,
        other.installations?.find(
          (entry) => entry.id === other.selectedInstallationId,
        )?.path,
        ...(other.args || []),
        ...(Array.isArray(other.env)
          ? other.env.map((entry) => entry[1])
          : Object.values(other.env || {})),
      ].some((value) => pathContains(root, value)),
  );
  return user
    ? `“${user.name || user.id}”仍在使用这份程序，请先更换它的程序。`
    : null;
}
export function programAction(
  input,
  action,
  installationId,
  busyCount = 0,
  options = {},
) {
  const agent = normalizeAgent(input);
  if (busyCount || agent.accessJob) return input;
  if (action === "disconnect")
    return {
      ...agent,
      connected: false,
      connectionState: "idle",
      setupComplete: false,
      demoReady: false,
      connectionRevision: agent.connectionRevision + 1,
      setupDraft: { ...agent.setupDraft, test: "idle", testFingerprint: null },
    };
  if (agent.connected) return input;
  if (action === "register") {
    const installation =
      agent.installations.find((item) => item.id === installationId) ||
      agent.installations[0];
    if (!installation) return input;
    return {
      ...agent,
      added: true,
      registered: true,
      removed: false,
      installed: true,
      available: true,
      selectedInstallationId: installation.id,
    };
  }
  if (action === "remove")
    return {
      ...agent,
      removed: true,
      added: false,
      registered: false,
      available: false,
      selectedInstallationId: null,
      setupComplete: false,
      demoReady: false,
    };
  if (action === "uninstall") {
    const item = agent.installations.find(
      (entry) => entry.id === installationId,
    );
    if (
      !item?.managed ||
      item.inUse ||
      item.id === agent.selectedInstallationId ||
      installationReferenceIssue(agent, item, options.allAgents)
    )
      return input;
    return {
      ...agent,
      installations: agent.installations.filter(
        (entry) => entry.id !== installationId,
      ),
    };
  }
  return input;
}
