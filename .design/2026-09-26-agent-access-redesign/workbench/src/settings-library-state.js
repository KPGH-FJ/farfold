// Local prototype policy. Never reads, deletes or restores actual Agent data.
import {
  archiveEligibility,
  filterConversations,
  hasUnsentContent,
} from "./history-policy.js";

export function libraryProtection(task) {
  if (hasUnsentContent(task)) return "还有未发送的内容，请先回到对话处理。";
  return archiveEligibility(task).allowed
    ? ""
    : archiveEligibility(task).reason;
}
export function libraryResults(tasks, filters) {
  return filterConversations(tasks, filters).filter(
    (task) => filters.state !== "drafts" || hasUnsentContent(task),
  );
}
export function deletionScope(tasks, ids) {
  const selected = tasks.filter((task) => ids.includes(task.id));
  return {
    selected,
    allowed: selected.filter((task) => !libraryProtection(task)),
    protected: selected.filter((task) => libraryProtection(task)),
  };
}
export function metadataSearch(tasks, query) {
  const q = query.trim().toLocaleLowerCase();
  return tasks.filter((task) =>
    [task.title, task.agent, task.group, task.folder]
      .join(" ")
      .toLocaleLowerCase()
      .includes(q),
  );
}
export const CLEAR_DATA_REMOVES = [
  "Farfold 的对话目录、分组与应用设置",
  "未发送草稿、附件记录、待发消息与未提交意见",
  "由 Farfold 安装且可安全清理的 Agent 程序",
  "Farfold 在系统安全存储中保存的 API 密钥",
  "未选工作文件夹的对话所用的应用对话文件夹",
];
export const CLEAR_DATA_KEEPS = [
  "各 Agent 自己的账号、配置和对话历史",
  "你选择的项目文件夹及其中的文件",
  "由其他方式安装的 Agent 程序",
];
