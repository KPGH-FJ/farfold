export const WORKTREE_PREPARATION_STRINGS = {
  open: "准备环境…",
  title: "准备这个工作位置",
  path: "工作位置",
  relativePath: "项目子目录（留空表示此位置）",
  task: "希望在这里做什么",
  taskPlaceholder: "例如：运行现有测试，或启动这个项目供本地查看。",
  service: "需要启动本地服务",
  port: "期望端口（可留空）",
  portNote: "这里只记录期望端口，未检查是否可用，也不会预留端口。",
  inspect: "检查并预览请求",
  manual: "不检查，编写准备请求",
  checking: "正在核查工作位置…",
  validating: "正在复验并保存到输入框…",
  saving: "正在重试保存已加入的内容…",
  readBoundary:
    "只检查所选目录下固定文件名的类型，不读取文件正文，不执行命令。关闭此窗口只放弃本次加入请求，不代表文件检查已经结束。",
  manualBoundary:
    "未检查此位置的文件、依赖或端口。发送后，由当前 Agent 按现有权限处理你的请求。",
  notRegistered:
    "此位置没有唯一的已登记记录。可以先在工作树中核对，或不检查而编写普通准备请求。",
  facts: "本次观察到的文件名",
  complete:
    "已完成 22 个固定名称的类型检查；这不代表依赖已安装或项目可以运行。",
  incomplete: "部分名称无法检查；无法检查不等于不存在。",
  isolation:
    "工作位置不提供完整环境隔离。账号、缓存和端口仍可能共享；没有检查这些资源。",
  gitMain: "当前是主仓库目录。",
  gitLinked: "当前是关联的工作树目录。",
  otherTrees: (count: number) => `另外发现 ${count} 个已登记工作树。`,
  review: "将加入输入框的请求",
  reviewNote:
    "请先审阅。现有内容、附件和文件意见会保留；加入后仍需你明确发送。",
  add: "加入输入框",
  added: "已加入并保存，尚未发送。",
  unsaved: "已加入输入框，但尚未保存成功。内容保留，请重试保存；不会再次加入。",
  retrySave: "重试保存",
  saveStale:
    "内容已加入，但原草稿或当前选择已变化，无法在此重试保存。请关闭后在输入框确认并保存。",
  saveBeforeFailed: "尚未加入：原草稿保存失败。请先保存原草稿后再试。",
  stale: "原草稿或当前选择已变化，未加入请求。请关闭后重新打开。",
  cancelled: "已放弃本次加入；没有发送请求。",
  close: "关闭",
  invalid:
    "请填写任务，并检查子目录和端口。子目录最多八层，不能使用上级目录或绝对路径。",
  unavailable: "此次检查未完成，请稍后明确重试，或编写未检查的普通请求。",
  request: {
    project: (path: string) => `请协助准备此项目：${path}`,
    task: (task: string) => `我的任务：${task}`,
    scope: (path: string) =>
      `检查范围：${path}，只检查了 22 个固定名称的类型。`,
    desiredPort: (port: string) =>
      `我希望启动本地服务，期望端口 ${port}。端口尚未检查或预留；若不可用，请说明并与我确认替代方案。`,
    choosePort:
      "我希望启动本地服务。请先确认所需端口，说明现状与冲突，再由我确认。",
    noService: "本次没有要求启动本地服务，请勿自行启动长期运行的服务。",
    execution:
      "以上文件名和类型只是检查时的观察，不代表依赖完整或环境已就绪。请结合项目说明和我的任务提出具体准备步骤，在现有权限及审批下执行；不要擅自更改服务、模型或权限。",
    protect:
      "不要复制其他工作位置的未提交内容、被忽略的文件或秘密，不要读取、输出或替换凭据。涉及安装、网络访问或文件更改时，先说明用途与范围。",
    results:
      "请报告实际执行的步骤、验证结果、失败原因与留下的文件。若未完成，保留现状并给出可重试的下一步；不要把请求停止等同于命令已经结束。",
  },
  kinds: {
    missing: "不存在",
    file: "文件",
    directory: "文件夹",
    symlink: "链接（未跟随）",
    other: "其他类型",
    unreadable: "无法检查",
  },
  errors: {
    unavailable: "此次检查未完成，请稍后明确重试，或编写未检查的普通请求。",
    storageUnavailable: "暂时无法读取位置记录，请先恢复保存功能后重试。",
    storageUnknown: "位置记录的保存结果尚未确认，请先核对记录后重试。",
    busy: "另一次操作尚未结束，请稍后明确重试。",
    changed: "位置或文件情况已经变化，请重新检查并审阅请求。",
    missing: "工作位置目前无法找到，请在工作树中核对。",
    unsafePath: "此路径无法安全检查，请选择此位置内的普通子目录。",
    unsupportedGit: "当前 Git 无法完成这项检查，请先处理后重试。",
    inspectionExpired: "这次检查已经过期，请重新检查并审阅请求。",
    readPending: "文件检查仍未返回结果。没有加入请求，请稍后明确重试。",
    readBusy: "其他文件检查仍在进行，请稍后明确重试。",
    capacity: "暂时无法保存新的检查结果，请稍后明确重试。",
  },
} as const;

export function preparationFailureMessage(value: unknown): string {
  if (value && typeof value === "object" && "code" in value) {
    const code = value.code;
    if (
      typeof code === "string" &&
      Object.hasOwn(WORKTREE_PREPARATION_STRINGS.errors, code)
    )
      return WORKTREE_PREPARATION_STRINGS.errors[
        code as keyof typeof WORKTREE_PREPARATION_STRINGS.errors
      ];
  }
  return WORKTREE_PREPARATION_STRINGS.unavailable;
}
