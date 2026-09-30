// Narrow v6 design-fixture correction, not a production/account migration.
// The removed catalog object is preserved in tests/fixtures/legacy-qwen-auth.js.
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function isLegacyQwenFixture(method) {
  return (
    exactKeys(method, [
      "id",
      "type",
      "presentation",
      "label",
      "accountLabel",
      "registration",
    ]) &&
    method.id === "terminal" &&
    method.type === "terminal" &&
    method.presentation === "terminal" &&
    method.label === "交互式登录" &&
    method.accountLabel === "Qwen 账号" &&
    exactKeys(method.registration, ["presentation", "demo"]) &&
    method.registration.presentation === "official-login" &&
    method.registration.demo === true
  );
}

export function migrateLegacyQwenAuthentication(snapshot) {
  if (snapshot?.version !== 6 || !Array.isArray(snapshot.agents))
    return snapshot;
  let changed = false;
  const agents = snapshot.agents.map((agent) => {
    if (agent?.id !== "qwen-code" || !Array.isArray(agent.authMethods))
      return agent;
    const authMethods = agent.authMethods.filter(
      (method) => !isLegacyQwenFixture(method),
    );
    if (authMethods.length === agent.authMethods.length) return agent;
    changed = true;
    const next = { ...agent, authMethods };
    // Another user-declared method can share an id: its selection and evidence
    // remain untouched. In-flight work and registration are always retained.
    if (!authMethods.some((method) => method?.id === "terminal")) {
      if (
        agent.authMethodSelection === "terminal" &&
        !agent.accessJob &&
        !agent.registration
      )
        delete next.authMethodSelection;
      if (
        agent.authentication?.method === "terminal" &&
        agent.authentication.status === "flow-finished"
      )
        next.authentication = {
          ...agent.authentication,
          status: "needs-check",
        };
    }
    return next;
  });
  return changed ? { ...snapshot, agents } : snapshot;
}

// Retired menu fixtures are removed by exact identity, never by a name prefix.
export function removeRetiredAuthenticationSamples(snapshot) {
  const names = {
    "review-auth-browser": "账号注册与登录示例",
    "review-auth-device": "认证交互示例 · 设备码",
    "review-auth-terminal": "认证交互示例 · 终端",
  };
  const retired = (snapshot.agents || []).filter(
    (agent) =>
      names[agent.id] === agent.name &&
      agent.description ===
        "独立交互提案，不对应任何真实 Agent 的已接通能力。" &&
      agent.authenticationEvidence ===
        "仅供交互评审；没有连接真实程序或账号。" &&
      agent.capabilitiesEvidence === "独立模拟能力，不代表任何品牌已经支持。",
  );
  if (!retired.length) return snapshot;
  const ids = new Set(retired.map((agent) => agent.id));
  const choice = snapshot.draft?.choice;
  const selected = choice?.agentId
    ? ids.has(choice.agentId)
    : retired.some((agent) => agent.name === choice?.agent);
  return {
    ...snapshot,
    agents: snapshot.agents.filter((agent) => !ids.has(agent.id)),
    ...(selected
      ? {
          draft: {
            ...snapshot.draft,
            choice: {
              agent: "",
              model: "",
              source: "沿用已有设置",
              accessMode: "existing",
            },
          },
        }
      : {}),
  };
}
