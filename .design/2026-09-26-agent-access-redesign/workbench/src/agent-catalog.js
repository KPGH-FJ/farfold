import { OBSERVED_CONFIGURATION_SAMPLE } from "./additional-configuration.js";
import { AGENT_DIRECTORY } from "./agent-directory.js";
import { authenticationFolder } from "./authentication-state.js";
import { ACCOUNT_CAPABILITIES } from "./account-capabilities.js";
import { APPROVAL_PRESET_SAMPLE } from "./permission-fixtures.js";
// These are review fixtures, never a claim about installed-product acceptance.
const authorizationExample = [
  {
    id: "browser",
    type: "agent",
    presentation: "browser",
    label: "账号授权",
    accountLabel: "OpenAI 账号",
    registration: { presentation: "official-login", demo: true },
  },
];
const entries = [
  {
    id: "codex",
    name: "Codex",
    permissionCapability: APPROVAL_PRESET_SAMPLE,
    configurationSamples: OBSERVED_CONFIGURATION_SAMPLE,
    publisher: "OpenAI",
    icon: "/assets/codex.svg",
    description: "处理代码、文件和项目任务，保留自己的账号与模型设置。",
    categories: ["编程", "自动化"],
    installed: true,
    connected: true,
    models: ["6 Astra", "5.6 Sol"],
    model: "6 Astra",
    efforts: ["Low", "Medium", "High", "Ultra"],
    version: "0.155.1",
    componentVersion: "1.12.0",
    apiFormats: ["responses"],
    serviceConfigurationReady: true,
    authMethods: authorizationExample,
    sourceUrl: "https://developers.openai.com/codex/",
    sourceLabel: "Codex 文档",
    supportNote: "已有接入实现；真实账号、模型请求及恢复仍需分别验证。",
  },
  {
    id: "opencode",
    name: "OpenCode",
    publisher: "Anomaly",
    icon: "/assets/opencode.svg",
    description: "沿用自己的模型服务，或选用 Farfold 中已保存的兼容服务。",
    categories: ["编程", "自动化"],
    installed: true,
    connected: true,
    models: ["Atria Dawn", "Big Pickle"],
    model: "Atria Dawn",
    efforts: ["Default"],
    version: "1.18.31",
    apiFormats: ["responses", "chat-completions"],
    serviceConfigurationReady: true,
    authMethods: [],
    sourceUrl: "https://opencode.ai/docs/",
    sourceLabel: "OpenCode 文档",
    supportNote: "共享服务交付已有实现；兼容格式不等于所选服务已通过真实请求。",
  },
  {
    id: "pi",
    name: "Pi",
    publisher: "Pi",
    icon: "/assets/pi-color.svg",
    description: "从已有设置开始，在同一工作台中继续你的工作。",
    categories: ["编程", "轻量"],
    installed: true,
    connected: true,
    models: ["GLM 4.5 Air", "Atria Dawn"],
    model: "GLM 4.5 Air",
    efforts: ["Off", "Low", "Medium", "High"],
    version: "0.80.5",
    componentVersion: "0.0.33",
    apiFormats: [],
    authMethods: [],
    sourceUrl: "https://pi.dev/",
    sourceLabel: "Pi 网站",
    supportNote:
      "可沿用已有设置或演示官方登录设置；Farfold 新服务交付与本机登录结果未确认。",
  },
  {
    id: "cline",
    name: "Cline",
    publisher: "Cline",
    categories: ["编程", "自动化"],
    description: "探索 Cline 的接入与已有配置，区分程序连接和模型服务可用性。",
    discovered: true,
    authMethods: [],
    apiFormats: [],
    models: [],
    efforts: [],
    sourceUrl: "https://github.com/cline/cline/blob/main/apps/cli/README.md",
    sourceLabel: "Cline CLI 项目说明",
    supportNote:
      "官方 CLI 有账号及自带 API 配置路线；Farfold 共享服务交付未确认。",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    publisher: "Qwen",
    categories: ["编程", "轻量"],
    description: "先复用本机设置；出现明确认证要求时再完成登录。",
    discovered: true,
    authMethods: [],
    apiFormats: [],
    models: [],
    efforts: [],
    sourceUrl: "https://github.com/QwenLM/qwen-code",
    sourceLabel: "Qwen Code 项目说明",
    supportNote:
      "交互式认证有接入处理；官方自定义 API 能力不代表 Farfold 已能交付共享服务。",
  },
  {
    id: "claude-agent",
    name: "Claude Agent",
    publisher: "目录接入项目",
    categories: ["编程", "自动化"],
    description: "通过目录接入项目探索 Claude Agent 的工作方式。",
    authMethods: [],
    apiFormats: [],
    models: [],
    efforts: [],
    sourceUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    sourceLabel: "Claude Agent 接入项目说明",
    supportNote:
      "项目提供订阅及 Console 登录路线；本机方法尚未读取，共享服务交付未确认。",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    publisher: "Google",
    categories: ["编程", "研究"],
    description: "探索目录中的编程与研究工具。",
    sourceUrl: "https://github.com/google-gemini/gemini-cli",
    sourceLabel: "Gemini CLI 项目说明",
  },
  {
    id: "goose",
    name: "goose",
    publisher: "Block",
    categories: ["自动化", "研究"],
    description: "探索面向不同工作场景的任务自动化。",
    sourceUrl: "https://block.github.io/goose/",
    sourceLabel: "goose 项目说明",
  },
  {
    id: "kimi-cli",
    name: "Kimi CLI",
    publisher: "目录收录",
    categories: ["编程", "自动化"],
    description: "了解目录中的更多编程工具。",
    sourceUrl: "https://moonshotai.github.io/kimi-cli/",
    sourceLabel: "Kimi CLI 文档",
  },
  {
    id: "fast-agent",
    name: "fast-agent",
    publisher: "目录收录",
    categories: ["研究", "轻量"],
    description: "探索轻量任务与研究工作的接入方式。",
    sourceUrl: "https://fast-agent.ai/",
    sourceLabel: "fast-agent 文档",
  },
];
const directoryEntries = [...AGENT_DIRECTORY]
  .sort((a, b) => {
    const rank = (row) => {
      const index = entries.findIndex((entry) => entry.id === row.id);
      return index < 0 ? entries.length : index;
    };
    return rank(a) - rank(b);
  })
  .map((directory) => {
    const fixture = entries.find((entry) => entry.id === directory.id);
    return {
      name: directory.directoryName,
      publisher: "目录收录",
      categories: [],
      ...fixture,
      ...directory,
      // Existing conversation names are stable; the directory uses current branding.
      name: fixture?.name || directory.directoryName,
      fixtureProvided: Boolean(fixture),
    };
  });
export const AGENT_CATALOG = directoryEntries.map((entry) => ({
  installed: false,
  connected: false,
  added: !!entry.installed,
  registered: !!entry.installed,
  available: !!entry.installed,
  setupComplete: false,
  onboardingComplete: entry.connected === true,
  removed: false,
  ready: false,
  proposal: false,
  authModes: [],
  models: [],
  efforts: [],
  authMethods: [],
  apiFormats: [],
  serviceConfigurationReady: false,
  installSupported: true,
  needsUpdate: false,
  sourceUrl: "https://agentclientprotocol.com/get-started/registry",
  sourceLabel: "接入目录",
  supportNote: "目录可发现；当前程序、认证和模型能力需分别检查。",
  ...entry,
  accountCapabilities: entry.fixtureProvided
    ? ACCOUNT_CAPABILITIES[entry.id]
    : undefined,
  authenticationDeclaration: entry.authMethods?.length
    ? "prototype-sample"
    : "not-read",
  capabilitiesEvidence: entry.fixtureProvided
    ? "原型能力样例，不代表本机检查结果"
    : "仅提供目录身份；程序、认证、模型能力尚未提供",
  authenticationEvidence: entry.authMethods?.length
    ? "这里展示登录交互样例；实际方式以所连接程序提供的选项为准。"
    : "尚未核实本机程序提供的登录方式。",
  serviceCapabilities: {
    status: entry.serviceConfigurationReady ? "implemented" : "unknown",
    formats: entry.apiFormats || [],
  },
  configOptions: [
    ...((entry.efforts || []).length
      ? [{ id: "effort", label: "推理等级", options: entry.efforts }]
      : []),
    ...(entry.configurationSamples || []),
  ],
}));
// Old review snapshots may lack newly documented read-only observations. Never
// carry these existing-source observations into an API source.
export function additionalOptionsFor(agent, selection = {}) {
  if (
    !agent ||
    [selection.access, selection.accessMode].includes("api") ||
    selection.serviceId ||
    selection.sourceId
  )
    return [];
  const current = agent.configOptions || [];
  const sample =
    AGENT_CATALOG.find((item) => item.id === agent.id)?.configurationSamples ||
    [];
  return [...current, ...sample].filter(
    (option, index, all) =>
      option.id !== "effort" &&
      all.findIndex((item) => item.id === option.id) === index,
  );
}
export const AGENT_CATEGORIES = ["全部", "编程", "自动化", "研究", "轻量"];
export function permissionCapabilityFor(agent) {
  if (!agent) return null;
  // Older saved review data can acquire new fixture metadata without replacing
  // its credentials, drafts, selected programs, or explicit capability data.
  if (Object.hasOwn(agent, "permissionCapability"))
    return agent.permissionCapability;
  return (
    AGENT_CATALOG.find((entry) => entry.id === agent.id)
      ?.permissionCapability || null
  );
}
export function permissionSelectionFor(agent, choice) {
  const capability = permissionCapabilityFor(agent);
  if (!capability?.options?.length) return null;
  return {
    permissionCapability: structuredClone(capability),
    permissionValue: choice?.permissionValue ?? capability.currentValue,
  };
}
export function catalogState(catalog, agents = []) {
  const row = agents.find(
    (agent) => agent.id === catalog.id || agent.name === catalog.name,
  );
  return {
    ...catalog,
    ...(!row
      ? {
          installed: false,
          connected: false,
          registered: false,
          discovered: !!(catalog.discovered || catalog.installed),
        }
      : {}),
    ...row,
    directoryId: catalog.directoryId,
    directoryName: catalog.directoryName,
    icon: catalog.icon,
    onboardingComplete: row
      ? (row.onboardingComplete ?? row.setupComplete === true)
      : false,
    added: row
      ? !!(row.added ?? row.registered ?? row.available) && !row.removed
      : false,
  };
}
export function setupTestFingerprint(agent, draft, services = []) {
  const service =
    draft.access === "api"
      ? services.find((item) => item.id === draft.serviceId)
      : null;
  return JSON.stringify([
    agent.id,
    agent.selectedInstallationId || "default",
    agent.programRevision || 0,
    agent.connectionRevision || 0,
    draft.access || "existing",
    authenticationFolder(draft.folder),
    service?.id || null,
    service?.endpoint || null,
    service?.format || null,
    service?.revision || 0,
    service?.secretRevision || 0,
    draft.model || "",
    draft.effort || "",
    Object.entries(draft.configValues || {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);
}
