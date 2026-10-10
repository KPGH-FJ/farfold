export const WORKTREE_STRINGS = {
  title: "工作树",
  location: "工作位置",
  ordinary: "选择已有文件夹",
  inspect: "选择仓库文件夹",
  create: "创建工作树",
  manage: "已有工作树",
  use: "使用此位置",
  forget: "从清单移除",
  forgetNote: "只移除此清单记录，不删除文件、分支或对话。",
  check: "重新核查",
  refresh: "刷新清单",
  cancel: "请求停止创建",
  cancelRequested: "已请求取消，请核查实际结果并保留可能留下的材料。",
  close: "关闭",
  loading: "正在读取工作位置…",
  empty: "尚未加入工作树。也可以直接选择已有文件夹。",
  note: "工作树提供另一个文件夹；账号、Git设置和部分依赖仍可能共享。",
  noSetup: "只创建文件，不运行项目脚本、不安装依赖、不复制未提交内容或秘密。",
  delayed: "结果保留在此处。只有明确选择“使用此位置”才会更改当前草稿。",
  unavailable: "暂时无法核实工作树，请重新核查或选择已有文件夹。",
  unknown: "操作结果尚未确认。请核查这次操作，不要重复创建或删除已有材料。",
  unknownId: "没有取得这次操作的可靠结果，不能据此判断目录是否已经创建。",
  changed: "当前草稿或工作位置已变化，请重新选择。",
  loadFailed: "无法读取工作树清单，原记录保持。",
  checkFailed: "本次核查未取得结果；已确认的上次结果保留。",
  forgetFailed: "未确认清单是否已移除，请刷新核对。",
  blocked: "此仓库暂不能通过这里创建。已有文件夹仍可直接选择。",
  details: "查看原因",
  branch: "分支",
  newBranch: "新建分支",
  existingBranch: "使用已有本地分支",
  branchName: "新分支名称",
  start: "起点分支",
  currentCommit: "当前提交",
  parent: "目标父文件夹",
  selectParent: "选择目标父文件夹",
  directory: "新文件夹名称",
  more: "读取更多分支",
  refsLimit:
    "这里只列出前1000个本地分支。可使用当前提交创建，或选择已有文件夹。",
  inUse: "已在其他位置使用",
  invalid: "请补全新文件夹和分支信息。",
  created: "由此处创建",
  existing: "已有工作树",
  adopt: "加入清单",
  repositoryLocations: "仓库中的位置",
  materials: "可能留下的位置",
  materialsNote:
    "这些位置来自未确认的操作；不表示文件存在或工作树已完成。核查后才能另行加入清单和使用。",
  review: "查看未知结果说明",
  reviewNote:
    "结果仍未知。将保留可能留下的位置，不会删除材料或重试；确认已查看后可继续其他操作。这不代表创建成功或此前操作已停止。",
  confirmReview: "已查看说明，保留位置并继续",
  reviewed: "已保留未知结果的位置，仍未确认创建结果。",
  verified: "已核实位置",
  missing: "目录不存在",
  replaced: "位置已变化",
  unverified: "使用前将重新核查",
  saved: "位置已应用到当前草稿，尚未发送。",
  pending: "先处理当前创建结果，再开始另一项创建或接入。",
  states: {
    preparing: "正在准备创建…",
    prepared: "准备完成，尚未开始创建",
    running: "正在创建…",
    cancelling: "已请求停止，正在等待实际结果…",
    ready: "创建或接入完成",
    cancelled: "已取消，未开始创建",
    failed: "未开始创建",
    unknown: "结果未确认",
  },
  blockers: {
    gitUnavailable: "找不到可用的Git程序。",
    unsupportedGit: "当前Git不具备所需操作。",
    bare: "此仓库没有普通工作文件夹。",
    unborn: "此仓库还没有提交。",
    detached: "当前未选定本地分支。",
    filters: "此仓库需要额外的文件转换程序。",
    partialClone: "此仓库可能需要下载尚未保存在本机的内容。",
    sparseCheckout: "此仓库仅检出了部分目录。",
    submodules: "此仓库包含子模块。",
    locked: "此工作树已锁定。",
    unsafePath: "此路径无法按当前安全条件处理。",
    tooLarge: "仓库信息超出当前处理范围。",
    environmentOverride: "当前Git环境有额外位置设置。",
    unavailable: "暂时无法核实仓库状态。",
  },
  errors: {
    inspectionExpired: "仓库检查已过期，请重新选择仓库文件夹。",
    invalidRef: "分支名称或起点无效，请重新选择。",
    branchExists: "同名分支已经存在，请改名或选择已有分支。",
    branchInUse: "此分支正在另一工作树中使用。",
    targetExists: "目标文件夹已经存在，请选择其他新名称。",
    changed: "仓库或目标位置已变化，请重新检查。",
    capacity: "工作树清单已满，可先移除不再需要的清单记录。",
    busy: "另一项工作树操作尚未结束，请先核查其结果。",
    cancelled: "操作已取消，未开始创建。",
    waitExpired: "等待已结束，实际结果仍需重新核查。",
    storageUnknown: "保存结果尚未确认，请核查这次操作。",
    storageConflict: "工作树记录已变化，请刷新清单。",
    operationConflict: "这次操作的信息与原记录不同，请核查原操作后再继续。",
    recheckRequired: "使用前需要重新核查此位置。",
    alreadyKnown: "此位置已在清单中，请在已有工作树中选择。",
  },
} as const;
export function worktreeErrorMessage(code: string): string {
  const message =
    WORKTREE_STRINGS.errors[code as keyof typeof WORKTREE_STRINGS.errors];
  return typeof message === "string" ? message : worktreeBlockerMessage(code);
}
export function worktreeBlockerMessage(code: string): string {
  const message =
    WORKTREE_STRINGS.blockers[code as keyof typeof WORKTREE_STRINGS.blockers];
  return typeof message === "string" ? message : WORKTREE_STRINGS.unavailable;
}
const safeMessages = new Set<string>([
  ...Object.values(WORKTREE_STRINGS).flatMap((value) =>
    typeof value === "string" ? [value] : [],
  ),
  ...Object.values(WORKTREE_STRINGS.errors),
  ...Object.values(WORKTREE_STRINGS.blockers),
]);
/** Only the fixed Failure DTO or our own translated error can reach the UI. */
export function worktreeFailureMessage(value: unknown): string {
  if (value instanceof Error && safeMessages.has(value.message))
    return value.message;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "code" in value &&
    typeof value.code === "string"
  )
    return worktreeErrorMessage(value.code);
  return WORKTREE_STRINGS.unavailable;
}
