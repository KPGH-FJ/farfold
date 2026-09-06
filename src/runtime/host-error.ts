const explanations: Record<string, string> = {
  host_maintenance: "应用正在执行维护操作。请等待维护完成后重试。",
  session_busy: "当前对话已有任务正在运行。请先停止或等待该任务完成后重试。",
  working_copy_occupied:
    "这个工作目录已有任务正在运行。请先停止或等待该任务完成后重试，或选择独立的工作副本。",
  application_limit_reached:
    "同时运行的任务已达到上限。请先停止或等待其中一项完成后重试。",
};

/** Format only the Host's exact admission contract; preserve every other error. */
export function explainHostError(message: string): string {
  const match =
    /^(?:Error: )?Host rejected Turn admission: blockers=([a-z_,]+); conflicting_turn_ids=([a-zA-Z0-9_,-]*)$/.exec(
      message,
    );
  if (!match) return message;
  const blockers = [...new Set(match[1].split(","))];
  if (blockers.some((blocker) => !Object.hasOwn(explanations, blocker)))
    return message;
  return blockers.map((blocker) => explanations[blocker]).join(" ");
}
