/** User-visible copy for the connection account summary block. */
export const CONNECTION_ACCOUNT_STRINGS = {
  kinds: {
    account: "账号登录",
    api_key: "API 密钥",
    gateway: "自定义模型服务",
    external: "其他认证方式",
    none: "未登录",
    credential: "已检测到登录资料",
    missing_credential: "未检测到登录资料",
    not_required: "当前服务不要求登录",
  },
  ariaLabel: "当前账号",
  planPrefix: "账号方案：",
  noteAgentChecked: "由 Agent 检查本地设置；尚未验证服务是否可用。",
  noteAgentReported: "由 Agent 报告；实际服务与模型以当前选择为准。",
  currentIdentity: {
    title: "本次对话身份",
    read: "读取本次对话身份",
    reading: "正在读取身份…",
    notProvided: "本次未提供身份信息",
    workspace: "工作区",
    organization: "组织",
    scope:
      "由 Agent 报告，可能来自缓存；不证明当前已认证或付费方案。读取时可能发生 Agent 自身的凭据维护。",
    errors: {
      unavailable: "当前无法读取身份。",
      changed: "当前对话已变化，请返回后重新查看。",
      busy: "请先完成当前工作，再读取身份。",
      timeout: "读取尚未确认，请稍后查看。",
      invalidResponse: "返回的身份信息无法确认。",
      queryFailed: "未能读取身份信息。",
    },
  },
} as const;
