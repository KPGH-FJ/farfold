// Review fixtures, not capabilities declared by a real Agent.
export const COMMAND_EXAMPLES = [
  { name: "/help", description: "查看这个示例中的命令帮助。" },
  {
    name: "/compact",
    description: "整理当前对话上下文；这里只填入文字，不执行。",
  },
  {
    name: "/review-project-accessibility-and-keyboard-navigation",
    description:
      "长描述演示：检查项目中各个页面的键盘导航、焦点位置、弹窗关闭后的返回位置、展开和收起控件的状态，以及长文件名和大量附件在窄窗口中的呈现。保留每一个具体问题及其位置，先提出建议，等待确认之后再继续。这里不会运行检查，只用于验证命令列表是否能完整阅读和选择。",
  },
  {
    name: "/summarize-research-notes-with-original-source-locations",
    description:
      "将多份研究笔记整理成便于讨论的提纲，保留原文出处与尚未确认的内容；这是长名称示例，不表示当前 Agent 实际提供此命令。",
  },
  { name: "/review", description: "审阅示例项目，列出需要讨论的问题。" },
  { name: "/plan", description: "先整理目标与步骤，不自动执行。" },
];
export function filterCommands(commands, query) {
  const term = query.trim().toLocaleLowerCase();
  return commands.filter((item) =>
    `${item.name} ${item.description}`.toLocaleLowerCase().includes(term),
  );
}
export function insertCommand(text, command) {
  const content = text.endsWith("/") ? text.slice(0, -1) : text;
  return `${command}${content ? `\n${content}` : " "}`;
}
export const ATTACHMENT_EXAMPLES = [
  "资料/项目说明.md",
  "资料/读书笔记.md",
  "资料/旅行偏好.md",
  "设计评审/包含键盘导航、附件折叠与不同窗口宽度观察结果的完整产品评审记录.md",
  "资料/research-notes-with-a-very-long-unbroken-filename-for-layout-verification-2026-10-09.md",
  "截图/首页布局.png",
  "说明/版本一/修改意见.md",
  "说明/版本二/修改意见.md",
];
export function attachmentName(file) {
  return typeof file === "string" ? file : file.path || file.name || "附件";
}
