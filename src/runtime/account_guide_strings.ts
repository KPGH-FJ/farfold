export const ACCOUNT_GUIDE_STRINGS = {
  selectApi: "选择 API 服务",
  apiTitle: "API 账号与密钥",
  provider: "服务方",
  providerHint: "填写准备使用的服务，再继续注册或获取密钥。",
  providerPlaceholder: "公司、平台或自己的服务",
  continue: "继续",
  backConfig: "返回配置",
  fillConfig: "返回填写 API 配置",
  kept: "原 API 表单内容保留，没有保存或发送密钥。",
  apiKind: "API 服务",
  prepareKey: "准备账号与 API 密钥",
  prepareHint: "请自行向服务方获取 API 密钥；需要账号时，先完成注册或登录。",
  destination:
    "请使用服务方提供的官方入口；这里不会根据名称猜测注册或购买地址。",
  apiEmpty: "添加你的模型服务",
  apiEmptyHint:
    "已有 Agent 账号可以继续使用。只有想使用自己的 API 时，才需要在这里添加。",
  apiAdd: "添加 API 配置",
  apiBoundary: "保存、测试、实际使用，分别确认",
  apiBoundaryHint:
    "保存不会自动交付密钥。开始新对话时选择兼容服务与模型，已有对话保持原来源。",
  register: "没有账号？前往官网注册",
  registerSite: (name: string) => `没有账号？前往 ${name} 官网`,
  registerChoose: "没有账号？",
  registerChannels: (name: string) => `请通过 ${name} 的官方渠道注册账号`,
  docs: "查看官方说明",
  returnedPickMethod: "注册完成后，选择一种方式登录。",
} as const;
