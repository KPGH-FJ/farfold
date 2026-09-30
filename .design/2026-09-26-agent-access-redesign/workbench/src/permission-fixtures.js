// Design-only snapshot of docs/evidence/acp-handshakes/codex.json:250-284.
// A capability sample, never a fresh query or a rule for other Agents.
export const APPROVAL_PRESET_SAMPLE = {
  id: "mode",
  label: "权限",
  evidenceLabel: "历史能力样例",
  currentValue: "agent",
  options: [
    {
      value: "read-only",
      label: "请求批准",
      description: "编辑外部文件和使用互联网时始终询问。",
    },
    {
      value: "agent",
      label: "帮我批准",
      description: "仅对检测到的风险操作请求批准。",
    },
    {
      value: "agent-full-access",
      label: "完全访问权限",
      description: "可不受限制地访问互联网和电脑上的任何文件。",
      requiresConfirmation: true,
    },
  ],
};
