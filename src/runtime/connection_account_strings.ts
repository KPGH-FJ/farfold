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
} as const;
