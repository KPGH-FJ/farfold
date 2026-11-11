import type { FileCopyJob } from "./file_copy_jobs";
import { checkedCopyDestination, parseCopyStatus } from "./file_copy_types";

export type SavedCopyIntent = "open" | "reveal";
export type SavedCopyFailure =
  "changed" | "unreadable" | "pending" | "busy" | "unsupported" | "unavailable";
export interface SavedCopyAction {
  kind: SavedCopyIntent;
  pending: boolean;
  code?: SavedCopyFailure;
  completed?: true;
}
export function savedCopyTarget(job: FileCopyJob) {
  if (
    job.phase !== "known" ||
    job.absence ||
    !job.status ||
    job.status.state !== "completed" ||
    !job.status.settled
  )
    return null;
  try {
    const status = parseCopyStatus(
      job.status,
      job.file,
      job.destination,
      job.status.operationId,
    );
    if (!status.receipt?.destinationFile) return null;
    const file = checkedCopyDestination(status.receipt.destinationFile);
    return {
      file,
      stamp: JSON.stringify([
        job.id,
        { ...job.file },
        job.destination,
        status.operationId,
        status.receipt.kind,
        status.receipt.sourceVersion,
        status.receipt.size,
        status.receipt.sha256,
        file,
      ]),
    };
  } catch {
    return null;
  }
}

/** Only fixed native errors are translated; diagnostics never reach the UI. */
export function savedCopyFailure(error: unknown): SavedCopyFailure {
  if (error === "文件或位置已变化，请重新检查") return "changed";
  if (
    error === "文件已无法读取，请检查位置和访问权限" ||
    error === "此位置不是普通文件"
  )
    return "unreadable";
  if (
    error ===
    "文件检查尚未返回，后台可能仍在检查。请查看系统访问提示；仍无响应时，保存工作后退出重开。"
  )
    return "pending";
  if (
    error ===
    "已有文件检查尚未结束，本次未开始新检查。请稍后重试；仍无响应时，保存工作后退出重开。"
  )
    return "busy";
  if (error === "此文件请先定位到文件夹，再选择打开方式") return "unsupported";
  return "unavailable";
}
