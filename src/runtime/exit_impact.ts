import { conversationArchiveJobs } from "./conversation_archive_jobs";
import { threads } from "./sessions";
import { hasActiveAuthentication } from "./authentication";
import { UPDATE_IMPACT, updateConversationBlocker } from "./update_impact";
import { fileCopyJobs, hasUnsettledFileCopies } from "./file_copy_jobs";

export const EXIT_IMPACT = {
  title: "退出前确认",
  work: "仍有正在处理或结果尚未确认的工作。",
  consequence:
    "退出会结束应用与 Agent 的连接。未确认的工作不会被视为已完成或已停止，重新打开后也不会自动重发。",
  saved: "草稿、附件和待发消息会先保存；待发消息保持暂停。",
  stay: "留在应用",
  exit: "保存并退出",
  waiting: "正在保存更改并准备退出…",
  waitingNote:
    "留在应用只取消本次退出，正在进行的保存会继续。待发消息仍保持暂停。",
  cancelling: "正在确认取消退出…",
  cancelFailed: "暂时无法取消退出，请重试。",
  copying:
    "文件保存仍在进行，或尚未确认是否结束。请先核对或取消保存，待结果确认后再退出。",
  copyUnknown:
    "文件保存已结束，但结果仍未知。退出不会把它视为保存成功；再次打开后也不会自动重试。请核对目标文件。",
  copyReview: "退出前需要核对文件保存状态。可先留在应用，查看保存结果。",
  worktreeReview:
    "工作位置操作仍在进行，或尚未确认是否结束。请先留在应用查看结果，再尝试退出。",
  worktreeUnknown: "工作位置操作的结果尚未确认。",
  accountReview: "尝试退出时，Agent 账号操作仍在进行，或结果尚未确认。",
  conversationReview: (title: string, reason: string) =>
    `尝试退出时，「${title}」${reason}。`,
  applicationReview: "退出检查时，应用后台还有操作未确认结束。",
} as const;

export function hasUnknownFinishedFileCopies(): boolean {
  return (
    conversationArchiveJobs.hasUnknownFinished() ||
    fileCopyJobs
      .getSnapshot()
      .some(
        (job) =>
          job.absence === true ||
          (job.status?.state === "unknown" && job.status.settled),
      )
  );
}

export function exitReviewReason():
  { kind: "file" } | { kind: "activity"; detail: string } | null {
  if (hasUnsettledFileCopies() || hasUnknownFinishedFileCopies())
    return { kind: "file" };
  if (hasActiveAuthentication())
    return { kind: "activity", detail: EXIT_IMPACT.accountReview };
  for (const thread of threads.getSnapshot().threads.values()) {
    const reason = updateConversationBlocker(thread);
    if (reason)
      return {
        kind: "activity",
        detail: EXIT_IMPACT.conversationReview(
          thread.title?.trim() || UPDATE_IMPACT.untitled,
          reason,
        ),
      };
  }
  return null;
}
