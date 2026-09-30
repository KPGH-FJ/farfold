// Official documentation metadata for the review prototype, checked 2026-09-26.
// These actions are NOT authMethods returned by the connected program. A real
// implementation must resolve/confirm the intended CLI before using a command.
export const ACCOUNT_CAPABILITIES_VERSION = 1;
const sources = {
  codex: "https://developers.openai.com/codex/auth/",
  opencode: "https://opencode.ai/docs/cli/#auth",
  pi: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md",
  cline: "https://docs.cline.bot/cline-cli/getting-started",
  clineAccounts:
    "https://cline.bot/blog/one-api-key-for-claude-gemini-gpt-and-everything-else",
  clineAuth: "https://docs.cline.bot/usage/acp",
  qwen: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/",
  claude: "https://code.claude.com/docs/en/cli-reference",
  claudeProject:
    "https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts",
  gemini: "https://geminicli.com/docs/get-started/authentication/",
  goose:
    "https://github.com/block/goose/blob/main/documentation/docs/getting-started/providers.md",
  kimi: "https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html",
  fastAgent: "https://fast-agent.ai/models/llm_providers/",
};

// These pages establish where an account can be created. They are not OAuth
// callback URLs, installed authMethods, evidence of an account, or entitlement.
function accountPage(id, label, owner, url, sourceUrl) {
  return {
    id,
    status: "verified-entry",
    label,
    owner,
    url,
    sourceUrl,
    kind: "account-page",
  };
}
const accountPages = {
  chatgpt: accountPage(
    "chatgpt",
    "注册 ChatGPT 账号",
    "OpenAI / ChatGPT",
    "https://chatgpt.com/auth/login",
    "https://chatgpt.com/auth/login",
  ),
  cline: accountPage(
    "cline",
    "注册 Cline 账号",
    "Cline（用于 Cline 或 ClinePass）",
    "https://app.cline.bot/",
    sources.clineAccounts,
  ),
  claude: accountPage(
    "claude",
    "注册 Claude 账号",
    "Anthropic / Claude",
    "https://claude.ai/",
    "https://support.claude.com/en/articles/8325609-how-do-i-sign-up-for-the-pro-plan",
  ),
  console: accountPage(
    "anthropic-console",
    "注册 Anthropic Console 账号",
    "Anthropic Console",
    "https://platform.claude.com/login",
    "https://code.claude.com/docs/en/authentication#claude-console-authentication",
  ),
  google: accountPage(
    "google",
    "注册 Google 账号",
    "Google",
    "https://accounts.google.com/signup?utm_source=help",
    "https://support.google.com/accounts/answer/27441?hl=en",
  ),
};

function terminal(id, label, command, args, sourceUrl, owner, extra = {}) {
  const purpose = extra.purpose || "service";
  return {
    id,
    kind: "terminal",
    label,
    actionLabel: label,
    command,
    args,
    sourceUrl,
    evidence: "official-doc",
    execution: "simulation-only",
    purpose,
    interaction: {
      serviceSelection: purpose === "login" ? "fixed-account" : "agent-owned",
      resultEvidence: "recheck-required",
    },
    completion: "return-and-check",
    requiresProgramConfirmation: true,
    accountOwner: owner,
    // No signup endpoint is guessed. The provider decides whether its own
    // interactive flow offers registration, and what entitlement it requires.
    registration: {
      owner,
      kind: "official-guide",
      status: "unknown",
      label: "查看官方账号说明",
      sourceUrl,
      availability: "provider-dependent",
    },
    ...extra,
  };
}
function capability(accountOwner, sourceUrl, routes, extra = {}) {
  return {
    catalogMetadataVersion: ACCOUNT_CAPABILITIES_VERSION,
    accountOwner,
    localDeclaration: "not-read",
    checkedAt: "2026-09-26",
    evidence: "official-doc",
    routes,
    apiConfiguration: {
      status: "documented",
      sourceUrl,
      delivery: "agent-owned",
      farfoldDelivery: "separate-capability",
    },
    ...extra,
  };
}

export const ACCOUNT_CAPABILITIES = {
  codex: capability("OpenAI / ChatGPT", sources.codex, [
    terminal(
      "codex-login",
      "登录 ChatGPT 账号",
      "codex",
      ["login"],
      sources.codex,
      "OpenAI / ChatGPT",
      {
        purpose: "login",
        programLabel: "Codex CLI",
        registration: accountPages.chatgpt,
      },
    ),
  ]),
  opencode: capability(
    "所选模型服务提供商（也可选择 OpenCode 服务）",
    sources.opencode,
    [
      terminal(
        "opencode-provider",
        "登录或配置模型服务",
        "opencode",
        ["auth", "login"],
        sources.opencode,
        "所选模型服务提供商",
        { inputHint: "在终端中选择服务方及其提供的认证方式。" },
      ),
    ],
  ),
  pi: capability("所选模型服务提供商", sources.pi, [
    terminal(
      "pi-provider",
      "打开登录设置",
      "pi",
      [],
      sources.pi,
      "所选模型服务提供商",
      {
        programLabel: "Pi CLI",
        inputHint: "在终端中输入 /login，再选择服务方。",
      },
    ),
  ]),
  cline: capability("Cline 或所选模型服务提供商", sources.cline, [
    terminal(
      "cline-provider",
      "登录或配置模型服务",
      "cline",
      ["auth"],
      sources.cline,
      "Cline 或所选模型服务提供商",
      {
        inputHint: "按终端提示选择账号或自己的模型服务。",
        declarationSourceUrl: sources.clineAuth,
        // Cline and ClinePass share the Cline account; no separate signup is
        // invented for a subscription. Choosing a page does not pick a provider.
        registrationOptions: [accountPages.cline, accountPages.chatgpt],
      },
    ),
  ]),
  "qwen-code": capability(
    "阿里云或所选模型服务提供商",
    sources.qwen,
    [
      terminal(
        "qwen-provider",
        "打开服务配置",
        "qwen",
        [],
        sources.qwen,
        "阿里云或所选模型服务提供商",
        {
          inputHint: "在终端中输入 /auth，选择所用服务并完成配置。",
        },
      ),
    ],
    {
      note: "当前官方文档已停止 Qwen OAuth 免费入口；不能据此承诺 Qwen 账号授权。旧版行为仍需单独检查。",
    },
  ),
  "claude-agent": capability(
    "Anthropic（Claude 订阅或 Console）",
    sources.claude,
    [
      terminal(
        "claude-subscription",
        "登录 Claude 账号",
        "claude",
        ["auth", "login"],
        sources.claude,
        "Anthropic / Claude",
        {
          purpose: "login",
          programLabel: "Claude Code CLI",
          registration: accountPages.claude,
        },
      ),
      terminal(
        "claude-console",
        "登录 Anthropic Console",
        "claude",
        ["auth", "login", "--console"],
        sources.claude,
        "Anthropic Console",
        {
          purpose: "login",
          programLabel: "Claude Code CLI",
          registration: accountPages.console,
        },
      ),
    ],
    {
      declarationSourceUrl: sources.claudeProject,
      note: "接入项目会有条件地提供终端登录方式；当前本机声明尚未读取。文档命令需确认对应的 Claude Code 程序。",
    },
  ),
  "gemini-cli": capability(
    "Google（账号、AI Studio 或 Cloud）",
    sources.gemini,
    [
      terminal(
        "gemini-google",
        "登录或配置 Google 服务",
        "gemini",
        [],
        sources.gemini,
        "Google",
        {
          inputHint:
            "按终端提示选择 Sign in with Google，或相应的 API 配置方式。",
          registration: accountPages.google,
        },
      ),
    ],
  ),
  goose: capability("所选模型服务提供商", sources.goose, [
    terminal(
      "goose-provider",
      "配置模型服务",
      "goose",
      ["configure"],
      sources.goose,
      "所选模型服务提供商",
      { inputHint: "选择 Configure Providers，再选择服务方并按提示完成配置。" },
    ),
  ]),
  "kimi-cli": capability(
    "Moonshot AI / Kimi",
    sources.kimi,
    [
      terminal(
        "kimi-login",
        "登录 Kimi 账号",
        "kimi",
        ["login"],
        sources.kimi,
        "Moonshot AI / Kimi",
        { purpose: "login" },
      ),
    ],
    {
      // This bounded review verified account login, not all custom-provider paths.
      apiConfiguration: {
        status: "not-reviewed",
        sourceUrl: sources.kimi,
        delivery: "agent-owned",
        farfoldDelivery: "separate-capability",
      },
    },
  ),
  "fast-agent": capability("所选模型服务提供商", sources.fastAgent, [
    terminal(
      "fast-agent-codex",
      "登录 ChatGPT 账号",
      "fast-agent",
      ["auth", "provider", "login", "codex"],
      sources.fastAgent,
      "OpenAI / ChatGPT",
      { purpose: "login", programLabel: "fast-agent CLI" },
    ),
    terminal(
      "fast-agent-copilot",
      "登录 GitHub Copilot",
      "fast-agent",
      ["auth", "provider", "login", "copilot"],
      sources.fastAgent,
      "GitHub",
      { purpose: "login", programLabel: "fast-agent CLI" },
    ),
  ]),
};

const sameMetadata = (left, right) => {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameMetadata(left[key], right[key]),
    )
  );
};

// Recognize only the two unversioned built-in shapes shipped by this prototype.
// Full metadata equality is deliberate: matching an Agent name or just a CLI
// command must not overwrite an explicit custom/empty capability declaration.
function unversionedBuiltinMetadata(id, legacy) {
  const metadata = structuredClone(ACCOUNT_CAPABILITIES[id]);
  delete metadata.catalogMetadataVersion;
  if (!legacy) return metadata;
  metadata.routes = metadata.routes.map((route) => {
    delete route.interaction;
    delete route.declarationSourceUrl;
    delete route.registrationOptions;
    route.registration = {
      owner: id === "qwen-code" ? "所选模型服务提供商" : route.accountOwner,
      kind: id === "qwen-code" ? "provider-page" : "during-auth",
      availability: "provider-dependent",
    };
    return route;
  });
  return metadata;
}

// Apply once while restoring prototype state. Only documentation metadata is
// replaced; protocol methods, program choices, active work, and drafts survive.
// Unknown or versioned copies remain unchanged for explicit future migrations.
export function migrateBuiltinAccountCapabilities(agent) {
  const saved = agent?.accountCapabilities;
  const builtin = ACCOUNT_CAPABILITIES[agent?.id];
  if (
    !saved ||
    !builtin ||
    Object.hasOwn(saved, "catalogMetadataVersion") ||
    saved.evidence !== "official-doc" ||
    !Array.isArray(saved.routes) ||
    saved.routes.length === 0
  )
    return agent;
  if (
    !sameMetadata(saved, unversionedBuiltinMetadata(agent.id, true)) &&
    !sameMetadata(saved, unversionedBuiltinMetadata(agent.id, false))
  )
    return agent;
  return { ...agent, accountCapabilities: structuredClone(builtin) };
}

// An explicit capability object takes precedence, including an empty route list.
// Names/empty authMethods never imply a capability or a lack of account support.
export function accountCapabilities(agent = {}) {
  const metadata = agent.accountCapabilities ?? ACCOUNT_CAPABILITIES[agent.id];
  const result = metadata ?? {
    accountOwner: "由所选服务方决定",
    localDeclaration: "not-read",
    evidence: "unknown",
    routes: [],
    apiConfiguration: {
      status: "unknown",
      farfoldDelivery: "separate-capability",
    },
  };
  return {
    ...result,
    localDeclaration:
      agent.authenticationDeclaration ?? result.localDeclaration,
    routes: (result.routes || []).map((route) => ({
      ...route,
      ...(route.args ? { args: [...route.args] } : {}),
      ...(route.registration
        ? { registration: { ...route.registration } }
        : {}),
      ...(route.registrationOptions
        ? {
            registrationOptions: route.registrationOptions.map((page) => ({
              ...page,
            })),
          }
        : {}),
      ...(route.interaction ? { interaction: { ...route.interaction } } : {}),
    })),
  };
}

// Stable route lookup also supports returning from a provider-owned registration
// handoff. It never starts work or turns registration into authentication proof.
export function accountRoute(agent, id) {
  return (
    accountCapabilities(agent).routes.find((route) => route.id === id) ?? null
  );
}
