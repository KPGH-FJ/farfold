// Prototype-only menu transitions. They never call an Agent or the OS.
import { libraryProtection } from "./settings-library-state.js";

export function prepareMessageResend(task, message) {
  if (!message || (!message.text?.trim() && !message.attachments?.length))
    return null;
  return {
    draft: message.text || "",
    attachments: structuredClone(message.attachments || []),
    resendDraft: {
      previousDraft: task.resendDraft?.previousDraft ?? task.draft ?? "",
      previousAttachments: structuredClone(
        task.resendDraft?.previousAttachments ?? task.attachments ?? [],
      ),
    },
  };
}

export function messageBranchSnapshot(task, message) {
  if (!message || (!message.text?.trim() && !message.attachments?.length))
    return null;
  return {
    text: message.text || "",
    attachments: structuredClone(message.attachments || []),
    role: message.role || "user",
    originTaskId: task.id,
  };
}

export function conversationDeleteProtection(task) {
  if (
    task.resendDraft?.previousDraft?.trim() ||
    task.resendDraft?.previousAttachments?.length
  )
    return "还有暂存的原草稿，请先取消重发并处理。";
  return libraryProtection(task);
}

export function conversationDeletionRequest(task, confirmed) {
  return confirmed && task?.id && !conversationDeleteProtection(task)
    ? task.id
    : null;
}

export function attemptConversationDeletion(task, confirmed, remove) {
  const id = conversationDeletionRequest(task, confirmed);
  if (!id || typeof remove !== "function")
    return {
      phase: "blocked",
      message: conversationDeleteProtection(task) || "请先确认删除范围。",
    };
  try {
    if (remove(id) !== false) return { phase: "deleted", message: "" };
  } catch {
    // A save failure must keep the confirmation and the original conversation.
  }
  return {
    phase: "failed",
    message: "删除未保存，原对话保留。请检查未完成事项和浏览器保存状态后重试。",
  };
}

export function startFinderPreview(task, id) {
  return task.folder && id
    ? { id, folder: task.folder, phase: "pending", error: "" }
    : { phase: "failed", error: "这段对话没有工作位置。请先确认原工作位置。" };
}

export function finishFinderPreview(state, id, folder, outcome) {
  if (
    !state ||
    state.id !== id ||
    state.folder !== folder ||
    state.phase !== "pending"
  )
    return state;
  return {
    ...state,
    phase: outcome === "success" ? "success" : "failed",
    error:
      outcome === "success"
        ? ""
        : "未能显示工作位置。示例路径不可用，可以复制路径或重试。",
  };
}
