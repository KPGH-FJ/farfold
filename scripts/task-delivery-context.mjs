// Entry points for the active Codex slice. Current conclusions and completion
// conditions come from the task reader, and evidence remains at its source.
const sourcePaths = {
  "ARCH-08": [
    "src/components/AgentAuthSection.tsx",
    "src-tauri/src/acp_client/codex_daily/",
  ],
  P01: [
    "src/components/Composer.tsx",
    "src/components/ThreadView.tsx",
    "src/runtime/drafts.ts",
  ],
  "NEW-24": [
    "src-tauri/src/acp_client/codex_daily/",
    "src/runtime/conversation_access.ts",
    "src/components/PromptAdmissionStatus.tsx",
  ],
};

export function renderDeliveryContext(tasks) {
  const paths = tasks.flatMap(({ id }) =>
    (sourcePaths[id] ?? []).map((path) => `- ${id} → ${path}`),
  );
  return [
    "",
    "## 开发与验证入口",
    "",
    ...paths,
    ...(paths.length ? [""] : []),
    "按当前状态链接复核证据原件与未解决条件。工作区会随开发变化，请核对 git status、HEAD 与正式应用身份。",
    "以任务编号查收录证据：corepack pnpm acceptance:index --requirement <ID>；逐家续验可加 --agent <ID> --standard <S1–S8>。",
    "工程检查、正式操作回执、独审及交付见 docs/development-delivery.md。",
    "",
  ].join("\n");
}
