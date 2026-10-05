/** Reviewed presentation data only; never used to infer Agent capabilities.
 * Sources and unchanged artwork: docs/evidence/2026-10-03-agent-brand-colors/README.md.
 */
export interface AgentBrand {
  logo: string;
  description: string;
  sourceUrl: string;
  monochrome: boolean;
}

export const AGENT_BRANDS: Readonly<Record<string, AgentBrand>> = {
  "amp-acp": {
    logo: "/agents/amp-acp.svg",
    description: "按任务搭配模型，并在本地与云端之间接续工作。",
    sourceUrl: "https://ampcode.com/docs",
    monochrome: false,
  },
  "antigravity-acp": {
    logo: "/agents/antigravity-acp.svg",
    description: "Google 的智能开发平台，结合代码编辑、终端操作和浏览器验证。",
    sourceUrl: "https://antigravity.google/",
    monochrome: false,
  },
  auggie: {
    logo: "/agents/auggie.svg",
    description: "借助代码库上下文，理解跨文件关系并贴合现有工程修改。",
    sourceUrl: "https://docs.augmentcode.com/cli/overview",
    monochrome: true,
  },
  autohand: {
    logo: "/agents/autohand.svg",
    description: "通过记忆与技能积累项目经验，并按需要选择模型服务。",
    sourceUrl: "https://github.com/autohandai/code-cli",
    monochrome: true,
  },
  "claude-acp": {
    logo: "/agents/claude-acp.png",
    description: "让 Claude 规划多步骤任务，调用工具并分派子任务。",
    sourceUrl: "https://platform.claude.com/docs/en/agent-sdk/overview",
    monochrome: false,
  },
  cline: {
    logo: "/agents/cline.svg",
    description: "先规划再执行，可逐步审批文件修改与命令操作。",
    sourceUrl: "https://github.com/cline/cline",
    monochrome: true,
  },
  "codebuddy-code": {
    logo: "/agents/codebuddy-code.svg",
    description: "腾讯的编程工具，以自然语言串联需求、编码、测试与部署。",
    sourceUrl: "https://www.codebuddy.ai/docs/cli/overview",
    monochrome: false,
  },
  "codex-acp": {
    logo: "/agents/codex-acp.svg",
    description: "OpenAI 的本地编程工具，支持交互协作与脚本化执行。",
    sourceUrl: "https://github.com/openai/codex",
    monochrome: true,
  },
  "corust-agent": {
    logo: "/agents/corust-agent.svg",
    description: "专注 Rust 开发，理解所有权、生命周期和 Cargo 生态。",
    sourceUrl: "https://corust.ai/",
    monochrome: true,
  },
  cursor: {
    logo: "/agents/cursor.svg",
    description: "将 Cursor 的代码审查与编辑能力带到终端和自动化脚本。",
    sourceUrl: "https://cursor.com/docs/cli/overview",
    monochrome: false,
  },
  devin: {
    logo: "/agents/devin.svg",
    description: "衔接本地开发与云端任务，可从终端发起并跟进云端工作。",
    sourceUrl: "https://docs.devin.ai/cli",
    monochrome: true,
  },
  dimcode: {
    logo: "/agents/dimcode.png",
    description: "通过对话理解本地项目，并按项目组织代码任务与多条对话。",
    sourceUrl: "https://dimagent.com/en/docs/",
    monochrome: false,
  },
  dirac: {
    logo: "/agents/dirac.svg",
    description: "精确定位并并行修改代码，适合复杂项目与长时间开发任务。",
    sourceUrl: "https://dirac.run/",
    monochrome: false,
  },
  "factory-droid": {
    logo: "/agents/factory-droid.svg",
    description:
      "把完整工单、重构和问题排查交给 Droid，并在多种工具间接续工作。",
    sourceUrl: "https://factory.com/product/cli",
    monochrome: true,
  },
  "fast-agent": {
    logo: "/agents/fast-agent.svg",
    description: "用 Python 扩展工具与工作流程，组合云端或本地模型完成任务。",
    sourceUrl: "https://fast-agent.ai/",
    monochrome: false,
  },
  gemini: {
    logo: "/agents/gemini.svg",
    description: "结合 Google 搜索与文件、命令工具，处理代码和资料查找任务。",
    sourceUrl: "https://github.com/google-gemini/gemini-cli",
    monochrome: false,
  },
  "github-copilot-cli": {
    logo: "/agents/github-copilot-cli.svg",
    description:
      "在终端修改代码、处理 GitHub 议题与拉取请求，连接日常仓库协作。",
    sourceUrl:
      "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli",
    monochrome: true,
  },
  goose: {
    logo: "/agents/goose.svg",
    description: "通过扩展连接工作工具，在本机处理编程、研究、写作与数据分析。",
    sourceUrl: "https://goose-docs.ai/",
    monochrome: true,
  },
  "grok-build": {
    logo: "/agents/grok-build.png",
    description: "先规划再执行复杂代码任务，并让多个助手并行研究、实现和审查。",
    sourceUrl: "https://x.ai/build",
    monochrome: true,
  },
  junie: {
    logo: "/agents/junie.svg",
    description: "结合 JetBrains 代码理解能力，规划改动、完成实现并补充测试。",
    sourceUrl: "https://junie.jetbrains.com/",
    monochrome: false,
  },
  kilo: {
    logo: "/agents/kilo.svg",
    description: "在规划、编码和调试模式间切换，并按任务选用不同模型。",
    sourceUrl: "https://kilo.ai/",
    monochrome: false,
  },
  kimchi: {
    logo: "/agents/kimchi.svg",
    description: "让不同模型分担规划、实现与审查，并控制团队的模型使用预算。",
    sourceUrl: "https://kimchi.dev/",
    monochrome: false,
  },
  kimi: {
    logo: "/agents/kimi.png",
    description: "在对话与命令行之间切换，边理解代码边完成任务。",
    sourceUrl: "https://github.com/MoonshotAI/kimi-cli",
    monochrome: false,
  },
  "minimax-code": {
    logo: "/agents/minimax-code.jpg",
    description: "围绕 MiniMax 模型组织开发任务，支持多助手协作。",
    sourceUrl: "https://www.minimax.io/",
    monochrome: false,
  },
  "mistral-vibe": {
    logo: "/agents/mistral-vibe.svg",
    description: "自动结合项目结构、分支和提交记录，理解代码并推进修改。",
    sourceUrl: "https://github.com/mistralai/mistral-vibe",
    monochrome: false,
  },
  nova: {
    logo: "/agents/nova.svg",
    description: "按步骤拆解开发任务，结合项目结构给出代码建议。",
    sourceUrl: "https://www.compassap.ai/nova/",
    monochrome: false,
  },
  opencode: {
    logo: "/agents/opencode.svg",
    description: "开源且不限定模型供应商，可分别规划方案和执行代码修改。",
    sourceUrl: "https://github.com/anomalyco/opencode",
    monochrome: true,
  },
  "pi-acp": {
    logo: "/agents/pi-acp.svg",
    description: "核心精简，通过扩展、技能与主题定制自己的工作方式。",
    sourceUrl: "https://pi.dev/press-kit",
    monochrome: false,
  },
  poolside: {
    logo: "/agents/poolside.svg",
    description: "配合 Poolside 模型处理代码，兼顾本地开发和批处理。",
    sourceUrl: "https://github.com/poolsideai/pool",
    monochrome: false,
  },
  qoder: {
    logo: "/agents/qoder.svg",
    description: "先理解整个代码库，再规划实现，并保留项目知识与记忆。",
    sourceUrl: "https://docs.qoder.com/cli/overview",
    monochrome: true,
  },
  "qwen-code": {
    logo: "/agents/qwen-code.svg",
    description: "为通义千问模型优化，也可连接其他模型与开发工具。",
    sourceUrl: "https://github.com/QwenLM/qwen-code",
    monochrome: false,
  },
  sigit: {
    logo: "/agents/sigit.svg",
    description: "把模型推理留在本机，也可按需选择云端服务。",
    sourceUrl: "https://github.com/getsigit/sigit",
    monochrome: false,
  },
  stakpak: {
    logo: "/agents/stakpak.png",
    description: "持续关注应用运行状况，协助部署、排障和维护基础设施。",
    sourceUrl: "https://stakpak.dev/",
    monochrome: false,
  },
};

const BUILTIN_BRAND_IDS: Readonly<Record<string, string>> = {
  codex: "codex-acp",
  pi: "pi-acp",
};

/** Directory IDs and the three existing built-in identities share the artwork.
 * A custom entry never inherits a product identity from its name or command.
 */
export function agentBrand(card: {
  id: string;
  registryId?: string;
  custom?: boolean;
}): AgentBrand | undefined {
  if (card.custom) return undefined;
  const id = card.registryId ?? card.id.replace(/^registry:/, "");
  return AGENT_BRANDS[BUILTIN_BRAND_IDS[id] ?? id];
}
