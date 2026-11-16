export const WORKTREE_STRINGS = {
  title: "工作树",
  recovery: {
    open: "恢复到新文件夹…",
    title: "从提交副本恢复到新文件夹",
    note: "只在不存在的新文件夹恢复已验证的提交内容，不覆盖原位置。完成后仍需明确选择使用，不更改旧对话或自动发送。",
    independent:
      "恢复结果是独立仓库；它不因此取得已创建工作树的归档或删除权限。",
    confirm: "恢复到新文件夹",
    requested: "已提交这次恢复，请查看操作状态；不要重复创建。",
    ready: "已恢复到新文件夹，未更改草稿",
    failed: "未完成此次恢复，请查看原因并保留可能留下的材料。",
    cancelled: "此次恢复已取消，请查看实际结果。",
    unknown: "恢复结果尚未确认，请核查这次操作并保留目标文件夹，不要重复恢复。",
    preparing: "正在准备恢复…",
    running: "正在恢复提交内容…",
    cancelling: "已请求停止恢复，等待实际结果…",
    checkFirst: "先核验恢复副本，再选择新文件夹。",
  },
  removal: {
    title: "删除已归档的工作文件",
    open: "删除工作文件…",
    prepare: "准备提交恢复副本",
    prepareNote: "先保存本地提交的恢复副本并实际验证；这一步不会删除工作文件。",
    firstStep: "1. 准备恢复副本",
    secondStep: "2. 确认永久删除",
    status: "此次操作状态",
    confirm: "永久删除工作文件",
    confirmAck: "我已查看恢复副本和删除位置，确认永久删除此处的工作文件",
    confirmNote:
      "只删除下方保留位置的工作文件及对应工作树登记。分支、恢复副本、对话和原工作位置记录保持。",
    branchNote: "分支保留，不会删除分支。",
    localNote: "只核查本地内容，不连接远端，也不能据此确认提交已推送。",
    prepared: "恢复副本已验证；工作文件尚未删除。",
    ready: "工作文件已删除，提交恢复副本保留",
    failed: "此次操作未完成；请保留原归档及可能生成的恢复材料。",
    cancelled: "已停止此次准备，原归档仍保留。",
    unknown:
      "实际结果尚未确认。请核查这次操作，保留原位置、保留位置和恢复副本；不要重复删除。",
    revoked: "此次删除确认已撤回。请核查或停止当前操作，再重新检查影响。",
    resultNote: "不会更改草稿或自动发送。恢复副本不是可直接使用的工作文件夹。",
    recoveries: "提交恢复副本",
    recoveryNote:
      "副本保留本次核查的提交内容，可能包含已提交的敏感信息。它是本机副本，不是远程备份。",
    reviewNote:
      "删除结果仍未确认。将保留双路径和提交恢复副本，不会重试或继续删除；确认已查看也不会重新取得这个工作树的删除许可。",
    reviewed: "已保留未知结果和恢复材料，实际删除结果仍需核查。",

    path: "恢复副本位置",
    check: "核验恢复副本",
    verified: "本次已核验",
    unconfirmed: "尚未核实完整性",
    missing: "未找到恢复副本",
    changed: "恢复副本已变化",
    summary: (bytes: number) => `提交恢复包 ${bytes} 字节；完整性摘要见详情。`,
    roots: (count: number) => `保护 ${count} 个本地提交起点及其可达内容。`,
    hashes: "查看完整性摘要",
    bundleHash: "恢复包摘要",
    manifestHash: "内容清单摘要",
    rootsHash: "提交范围摘要",
    cancel: "请求停止此次操作",
    phases: {
      preparingRecovery: "正在准备提交恢复副本…",
      verifyingRecovery: "正在验证提交恢复副本…",
      awaitingConfirmation: "等待单独确认删除",
      deleting: "正在删除已确认的工作文件…",
      checkingOutcome: "正在核查删除结果…",
      finished: "此次处理已结束，请查看实际结果",
    },
  },
  reopen: "查看工作树操作",
  archive: "归档并保留文件",
  restore: "恢复原位置",
  archived: "已归档的工作树",
  checkArchive: "核对位置",
  archiveUnconfirmed: "位置尚未确认，请先核对。核对不会移动文件。",
  draftCatalogueChecking: "正在核对工作位置清单，尚未准备新对话。",
  draftCatalogueFailed: "工作位置清单尚未确认，请刷新清单后继续；草稿保持。",
  draftArchiveUnconfirmed:
    "此工作位置此前已归档；当前清单尚未确认，请先核对工作树清单。",
  archivedNote: "此工作树已归档。恢复原位置并核查后才能使用。",
  recycleBlocked: "仍有需要处理的内容或活动，请先查看原因。",
  recycleReview: "确认影响",
  recycleOriginal: "原位置",
  recycleRetained: "保留位置",
  recycleNote:
    "归档会移动工作文件并保留未提交和被忽略的内容；对话和原工作位置记录不会改变。这不是独立备份。",
  recycleResultNote: "归档与恢复不会更改草稿或自动发送。原工作位置记录保持。",
  restoreNote: "只恢复到原位置，不覆盖已有文件夹，也不会更改草稿或自动发送。",
  externalStopped: "我已停止其他程序使用这个工作树",
  externalNote:
    "Farfold 无法阻止其他程序继续修改文件；如果仍在使用，请先取消。",
  recycleCancel: "取消此次确认",
  recycleRetry: "重新检查影响",
  recyclePreparing: "正在准备文件维护…",
  recycleRunning: "正在处理工作文件…",
  recycleCancelled: "此次文件维护已取消，请核查实际位置。",
  recycleFailed: "未完成此次文件维护，请查看原因。",
  recycleUnknown:
    "实际位置尚未确认。原位置和保留位置均保留记录，请核查这次操作，不要重复移动或删除。",
  recycleReviewNote:
    "结果仍未确认。将保留原位置和保留位置的记录，不会删除、移动或重试。确认已查看后可继续其他操作，这不代表此前文件维护成功或已被撤销。",
  archiveReady: "工作树已归档，文件保留在下方位置",
  restoreReady: "已恢复原位置，未更改草稿",
  restoreTargetExists: "原位置已有文件夹，请先处理或移走该文件夹，再重新检查。",
  recycleCancelRequest: "请求停止文件维护",
  maintenanceHeld:
    "工作文件维护期间，已暂停编辑和后续发送。核查实际结果后恢复编辑，不会自动续发。",
  relatedConversations: (count: number) =>
    `关联 ${count} 段对话；原工作位置记录保持。`,
  materialSummary: (entries: number, bytes: number) =>
    `已核查 ${entries} 项文件和目录、${bytes} 字节。`,
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
  cancel: "请求停止操作",
  cancelRequested: "已请求取消，请核查实际结果并保留可能留下的材料。",
  close: "关闭",
  loading: "正在读取工作位置…",
  empty: "尚未加入工作树。也可以直接选择已有文件夹。",
  note: "同一文件夹里的对话共享文件。工作树提供另一个文件夹，账号、Git 设置和部分依赖仍可能共享。",
  noSetup:
    "只创建已提交的文件，不运行项目脚本、不安装依赖，也不复制未提交或被忽略的内容。",
  delayed: "结果保留在此处。只有明确选择“使用此位置”才会更改当前草稿。",
  unavailable: "暂时无法核实工作树，请重新核查或选择已有文件夹。",
  unknown: "操作结果尚未确认。请核查这次操作，不要重复创建或删除已有材料。",
  unknownId: "没有取得这次操作的可靠结果，请保留相关位置并核查。",
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
    "结果仍未知。将保留可能留下的位置，不会删除材料或重试；确认已查看后可继续其他操作。这不代表本次操作成功或此前操作已停止。",
  confirmReview: "已查看说明，保留位置并继续",
  reviewed: "已保留未知结果的位置，仍未确认实际结果。",
  verified: "已核实位置",
  missing: "目录不存在",
  replaced: "位置已变化",
  unverified: "使用前将重新核查",
  saved: "位置已应用到当前草稿，尚未发送。",
  pending: "请先核查当前操作，再开始另一项操作。",
  states: {
    preparing: "正在准备操作…",
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
    cleanupUnknown:
      "资料检查未能确认结束，请保留工作文件，退出并重新打开应用后再核查。",
    storageConflict: "工作树记录已变化，请刷新清单。",
    operationConflict: "这次操作的信息与原记录不同，请核查原操作后再继续。",
    recheckRequired: "使用前需要重新核查此位置。",
    alreadyKnown: "此位置已在清单中，请在已有工作树中选择。",
    maintenanceBusy: "正在维护工作文件，请先核查这次操作。",
    draftChanged: "未发送内容在检查后发生变化，请重新检查影响。",
    unsentWork: "相关位置还有未发送内容，请先保留并处理。",
    unknownDrafts: "未能核实未发送内容，请先恢复读取后再继续。",
    notOwned: "此位置不属于由这里创建的工作树，不能通过这里归档。",
    notLinked: "只能归档另行创建的工作树，不能移动仓库主目录。",
    archived: "此工作树已归档，请从已归档清单恢复原位置。",
    missingArchive: "没有找到保留的工作树，请核查原位置与保留位置。",
    archiveParentChanged: "保留位置的父目录已变化，请重新检查。",
    materialChanged: "工作文件在检查后发生变化，请重新检查。",
    materialLimit: "工作文件超出当前核查范围，尚未移动。",
    nestedRepository: "此目录中另有仓库，暂不能通过这里归档。",
    specialFile: "此目录包含暂不能完整核查的文件，尚未移动。",
    uncommittedMaterial:
      "工作文件与已提交内容不同，可能有改动、未跟踪或被忽略的材料。请先保留并处理，不能继续删除。",
    dirtyTracked: "已跟踪文件还有改动，请先保留并处理。",
    untrackedMaterial: "还有未跟踪的材料，请先保留并处理。",
    ignoredMaterial: "还有被忽略的材料，请先保留并处理。",
    unprovenPrivateCommits: "尚不能完整保护此工作树的本地提交，请保留原归档。",
    recoveryLimit: "提交恢复副本超出当前处理范围，请保留原归档。",
    missingRecovery: "恢复副本尚未核实，请先重新核验恢复副本，再选择恢复位置。",
    recoveryInvalid: "提交恢复副本未通过实际恢复核验，不能继续删除。",
    recoveryChanged: "提交恢复副本在检查后发生变化，不能继续删除。",
    confirmationRequired: "删除工作文件需要再次明确确认。",
    connectionUnconfirmed: "相关程序是否已结束尚未确认，请先处理其工作。",
  },
} as const;
export function worktreeErrorMessage(code: string, action?: string): string {
  if (action === "restore" && code === "targetExists")
    return WORKTREE_STRINGS.restoreTargetExists;
  const message =
    WORKTREE_STRINGS.errors[code as keyof typeof WORKTREE_STRINGS.errors];
  return typeof message === "string" ? message : worktreeBlockerMessage(code);
}
/** Preserve raw causes; combine only identical user-facing explanations. */
export function worktreeBlockerReasons(
  codes: readonly string[],
  unsent: boolean,
  action?: string,
): readonly string[] {
  return [
    ...new Set([
      ...codes.map((code) => worktreeErrorMessage(code, action)),
      ...(unsent ? [WORKTREE_STRINGS.errors.unsentWork] : []),
    ]),
  ];
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
export function worktreeFailureMessage(
  value: unknown,
  action?: string,
): string {
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
    return worktreeErrorMessage(value.code, action);
  return WORKTREE_STRINGS.unavailable;
}
