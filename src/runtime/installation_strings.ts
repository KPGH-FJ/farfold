export const INSTALLATION_INPUT_STRINGS = {
  title: "安装时的启动模型",
  hint: "请核对本次启动参数。点击安装后将检查并选用新程序。",
  modelHint: "填写模型名称或已配置的模型代号，不要填写 API 密钥。",
  inherited: "留空将沿用目录与已有程序的启动设置。",
  useExisting: "沿用目录与已有启动设置",
  inheritedPreview: "此次不追加模型参数，沿用目录与已有程序的启动设置。",
  catalogDefault: (value: string) =>
    `目录提供的默认模型：${value}。实际使用由 Agent 的已有设置和启动参数决定。`,
  source: "查看官方参数说明",
  preview: "本次安装的启动参数",
  noValue: "尚未填写",
  invalid:
    "此输入未保存。请填写公开模型名称，不要包含密钥、网址、空格或额外参数。",
  savedInvalid: "之前保存的启动模型无法使用，请重新填写或明确沿用启动设置。",
  changed: "安装声明已变化，请按当前说明重新填写。原输入已保留。",
  previous: "之前填写的模型",
  unconfirmed: "尚无法确认本次安装参数，原输入已保留。",
  unchanged: "失败或取消会保留原程序选择，不改变已有对话的模型。",
  linkFailed: "无法打开官方说明，请稍后重试。",
} as const;
