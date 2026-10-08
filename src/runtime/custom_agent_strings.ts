export const CUSTOM_AGENT = {
  title: "自定义 Agent 接入",
  description:
    "指定你选择的程序和参数。添加不代表连接成功，能力由之后的检查结果决定。",
  name: "显示名称",
  nameRequired: "请填写名称",
  command: "程序路径或命令",
  commandRequired: "请选择或填写一个可执行程序",
  commandInvalid: "程序路径不能包含换行",
  chooseFile: "选择程序文件…",
  args: "参数（每行一个）",
  argsHint: "每行一个参数，按顺序传给程序。",
  env: "环境变量（可选，每行一个 NAME=value）",
  envHint:
    "环境变量会随启动命令传给此 Agent。需要保密的值建议改用账号登录或 API 配置，避免直接写在这里。",
  envInvalid: "环境变量名只能包含字母、数字和下划线，且不能以数字开头。",
  envMissingName: "环境变量缺少名称（形如 NAME=value）。",
  envDuplicate: (name: string) => `环境变量 ${name} 重复，请只保留一行。`,
  cancel: "取消",
  add: "添加并检查",
  adding: "正在添加…",
} as const;
