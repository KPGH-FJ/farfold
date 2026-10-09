import { threads } from "./sessions";
import { hasActiveAuthentication } from "./authentication";
import { updateConversationBlocker } from "./update_impact";
import { fileCopyJobs, hasUnsettledFileCopies } from "./file_copy_jobs";

export const EXIT_IMPACT = {
  title: "退出前确认",
  work: "仍有正在处理或结果尚未确认的工作。",
  consequence:
    "退出会结束应用与 Agent 的连接。未确认的工作不会被视为已完成或已停止，重新打开后也不会自动重发。",
  saved: "草稿、附件和待发消息会先保存；待发消息保持暂停。",
  stay: "留在应用",
  exit: "保存并退出",
  cancelFailed: "暂时无法取消退出，请重试。",
  copying:
    "文件保存仍在进行，或尚未确认是否结束。请先核对或取消保存，待结果确认后再退出。",
  copyUnknown:
    "文件保存已结束，但结果仍未知。退出不会把它视为保存成功；再次打开后也不会自动重试。请核对目标文件。",
  copyReview: "退出前需要核对文件保存状态。可先留在应用，查看保存结果。",
} as const;

export function hasUnknownFinishedFileCopies(): boolean {
  return fileCopyJobs
    .getSnapshot()
    .some(
      (job) =>
        job.absence === true ||
        (job.status?.state === "unknown" && job.status.settled),
    );
}

export function exitNeedsReview(): boolean {
  return (
    hasUnsettledFileCopies() ||
    hasUnknownFinishedFileCopies() ||
    hasActiveAuthentication() ||
    [...threads.getSnapshot().threads.values()].some((thread) =>
      Boolean(updateConversationBlocker(thread)),
    )
  );
}
