export const SETTINGS_PRESENTATION = {
  shortcuts: "查看快捷键",
  privacy: "数据与隐私",
  privacyTitle: "你的数据如何保存",
  privacyHint: "了解对话、密钥和应用设置分别由谁管理。",
  privacyOpen: "查看说明",
  close: "关闭",
  understood: "知道了",
  advanced: "高级",
  sending: "暂停消息发送",
  sendingHint: "按位置暂停新消息，不停止进行中的任务。",
  manage: "管理",
  notification: "需要你时提醒",
  notificationHint: "Agent 请求批准、提问或工作出现异常时，给出桌面提醒。",
  sound: "提醒声音",
  soundHint: "只对需要处理的事项播放声音，普通输出保持安静。",
  unavailable: "尚未提供",
  closeDialog: "关闭当前弹窗",
  openSettings: "打开设置",
  searchAlias: "搜索对话（备用快捷键）",
  data: [
    {
      title: "对话目录与应用设置",
      text: "由 Farfold 保存在本机，包含资料文件夹、标题、收藏、分组、归档、未发内容和应用设置。",
    },
    {
      title: "完整对话与工作历史",
      text: "由你选择的 Agent 管理。Farfold 恢复对话时依赖 Agent 提供的历史。",
    },
    {
      title: "API Key",
      text: "保存在系统安全存储。保存配置不会自动发送给所有 Agent；使用时由你选择来源。",
    },
    {
      title: "LifeModel",
      text: "当前未启用，不采集、不提供偏好。未来方案必须由你查看来源并批准。",
    },
  ],
  dataScope: "移除接入、删除 API 配置和卸载程序各有范围，会在操作时分别说明。",
  life: {
    sub: "由你决定哪些工作偏好值得保留。",
    title: "当前尚未启用",
    badge: "产品说明",
    description:
      "LifeModel 当前尚未启用。Farfold 不会采集工作偏好，也不会把偏好用于对话。",
    principles: [
      { title: "有来源依据", text: "每条偏好都需要有原话和上下文作为依据。" },
      { title: "由你明确批准", text: "未经批准的候选不能进入长期偏好。" },
      {
        title: "使用范围可检查",
        text: "未来启用后，你可以检查将要使用的偏好和适用范围。",
      },
    ],
  },
} as const;
