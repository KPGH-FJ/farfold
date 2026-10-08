import { readableTranscript } from "./conversation-state.js";

// Export only a snapshot of already displayed prototype messages.
export function createConversationExport(task, messages) {
  const title = String(task.title || "示例对话").trim();
  const available = messages.filter((message) => message.text?.trim());
  if (!available.length) return null;
  const filename = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 80) || "示例对话"}.md`;
  const markdown = [
    `# ${title.replace(/[\r\n]+/g, " ")}`,
    "> Farfold 交互原型导出。仅包含当前界面已展示的示例消息，不代表真实 Agent 执行记录。未展示的历史、输入草稿与待发消息不在此文件中。",
    ...available.map(
      (message) =>
        `## ${message.role === "user" ? "你" : task.agent || "Agent"}\n\n${message.text.trim()}`,
    ),
    "",
  ].join("\n\n");
  return { filename, markdown, messageCount: available.length };
}

export function snapshotConversationExport(root, task) {
  const messages = [
    ...(root?.querySelectorAll(".conv-user-message,.conv-agent-message") || []),
  ].map((node) => {
    const clone = node.cloneNode(true);
    clone.querySelector(".conv-message-meta")?.remove();
    return {
      role: node.classList.contains("conv-user-message") ? "user" : "assistant",
      text: readableTranscript(clone),
    };
  });
  return createConversationExport(task, messages);
}

export function exportPreviewOutcome(snapshot, mode, attempt) {
  if (!snapshot)
    return {
      phase: "failed",
      reason: "当前没有可导出的已展示消息。请返回对话，展示消息后再试。",
    };
  if (mode === "waiting") return { phase: "preparing" };
  if (mode === "failed" && attempt === 1)
    return {
      phase: "failed",
      reason:
        "示例文件准备未完成。已有对话、输入草稿与待发消息均保留，可重试或关闭。",
    };
  return { phase: "ready" };
}
