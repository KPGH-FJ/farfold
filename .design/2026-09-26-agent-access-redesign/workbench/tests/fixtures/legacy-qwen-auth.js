// Historical source excerpt: workbench/src/agent-catalog.js, terminalAuth,
// read before the 2026-09-26 account-capabilities change in this task. That
// untracked source had no Git revision. This is the exact removed object;
// unlike earlier 09-24 and prototype-data.js examples it used authMethods.
export const LEGACY_QWEN_METHOD = {
  id: "terminal",
  type: "terminal",
  presentation: "terminal",
  label: "交互式登录",
  accountLabel: "Qwen 账号",
  registration: { presentation: "official-login", demo: true },
};
