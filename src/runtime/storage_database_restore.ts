export const DATABASE_RESTORE = {
  choose: "从完整副本恢复…",
  chooseTitle: "选择 Farfold 资料副本",
  fileType: "资料副本",
  checking: "正在检查副本…",
  title: "恢复完整资料",
  scope:
    "这会替换 Farfold 的 Agent 登记、对话列表、设置和未发送内容。现有材料会先完整保留。",
  boundary:
    "Agent 自己保存的历史和钥匙串不会更改。恢复后需要重新打开应用，待发内容不会自动发送。",
  captured: "已单独读取这份副本；之后修改所选文件不会改变本次确认的内容。",
  confirmChoice: "确认使用这份副本恢复以上资料",
  confirm: "保留当前材料并恢复",
  applying: "正在保留材料并恢复…",
  cancel: "取消这次选择",
  preparing:
    "上次恢复在保留材料时中断，原资料尚未更换。请检查储存空间和目录权限后，重新选择副本。",
  pending: "上次恢复尚未完成。现有材料已保留，可以继续这次恢复。",
  continue: "继续这次恢复",
  installed:
    "资料文件已恢复。重新打开后，还会检查保存的内容；确认可用前不会进入工作台。",
  restart: "重新打开 Farfold",
  restarting: "正在重新打开…",
  blocked: "暂时无法确认恢复材料的完整状态。已暂停操作，请保留所有材料。",
  unknown: "恢复结果尚未确认。请核对结果，不要重复恢复。",
  check: "核对恢复结果",
  noReceipt:
    "尚未发现已开始更换资料的记录。可以取消这次选择；已生成的材料会保留。",
  protected: "恢复前保留的完整材料：",
  retained: "保留的原文件：",
  partial: "本次保留下来的材料：",
  errors: {
    unsupported:
      "无法确认副本的格式或完整结构，请选择 Farfold 保存的有效副本。",
    tooLarge: "资料过大，本次无法安全处理。原材料已保留。",
    unavailable: "当前不能恢复，请等正在进行的操作完成后再试。",
    pendingTools: "请先核对尚未确认的工具修改，再恢复资料。原材料已保留。",
    expired: "这次选择已失效，请重新选择副本。",
    changed: "材料发生变化，已暂停恢复。请保留所有副本并核对结果。",
    storage: "恢复未完成，请检查储存空间和目录权限，并核对结果。",
    blocked: "恢复记录无法确认，已暂停操作。请保留原资料与所有副本。",
  },
  counts: (agents: number, sessions: number, settings: number) =>
    `${agents} 个 Agent 登记，${sessions} 条对话记录，${settings} 项设置`,
} as const;

export type DatabasePreview = {
  id: string;
  sourcePath: string;
  counts: {
    agents: number;
    sessions: number;
    settings: number;
    dismissedSessions: number;
  };
};
export type DatabaseStatus = {
  id: string | null;
  phase: "preparing" | "pending" | "installed" | "released" | "blocked";
  protectedPath: string | null;
  retainedPath: string | null;
  canContinue: boolean;
  canRestart: boolean;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(DATABASE_RESTORE.unknown);
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{48}$/.test(value);
}
function path(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16384 &&
    !value.includes("\0")
  );
}
export function checkedDatabasePreview(value: unknown): DatabasePreview {
  const raw = object(value),
    counts = object(raw.counts);
  if (
    !id(raw.id) ||
    !path(raw.sourcePath) ||
    ["agents", "sessions", "settings", "dismissedSessions"].some(
      (key) =>
        !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0,
    )
  )
    throw new Error(DATABASE_RESTORE.unknown);
  return value as DatabasePreview;
}
export function checkedDatabaseStatus(
  value: unknown,
  expected?: string,
): DatabaseStatus {
  const raw = object(value);
  if (
    !["preparing", "pending", "installed", "released", "blocked"].includes(
      raw.phase as string,
    ) ||
    (raw.id !== null && !id(raw.id)) ||
    (expected !== undefined && raw.id !== expected) ||
    (raw.phase !== "blocked" && raw.id === null) ||
    (raw.protectedPath !== null && !path(raw.protectedPath)) ||
    (raw.retainedPath !== null && !path(raw.retainedPath)) ||
    raw.canContinue !== (raw.phase === "pending") ||
    raw.canRestart !== (raw.phase === "installed") ||
    (!["blocked", "preparing"].includes(raw.phase as string) &&
      (!path(raw.protectedPath) || !path(raw.retainedPath)))
  )
    throw new Error(DATABASE_RESTORE.unknown);
  return value as DatabaseStatus;
}
export function initialDatabaseStatus(value: unknown): DatabaseStatus | null {
  if (value == null) return null;
  try {
    const status = checkedDatabaseStatus(value);
    return status.phase === "released" ? null : status;
  } catch {
    return {
      id: null,
      phase: "blocked",
      protectedPath: null,
      retainedPath: null,
      canContinue: false,
      canRestart: false,
    };
  }
}
export function databaseFailure(value: unknown): {
  message: string;
  materialsPath: string | null;
} {
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const message =
      typeof raw.code === "string" &&
      Object.hasOwn(DATABASE_RESTORE.errors, raw.code)
        ? DATABASE_RESTORE.errors[
            raw.code as keyof typeof DATABASE_RESTORE.errors
          ]
        : DATABASE_RESTORE.unknown;
    return {
      message,
      materialsPath: path(raw.materialsPath) ? raw.materialsPath : null,
    };
  }
  return { message: DATABASE_RESTORE.unknown, materialsPath: null };
}
