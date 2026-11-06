import { expect, it } from "vitest";
import { STRINGS } from "./strings";
import { uiError } from "./ui_error";

const failures = [
  ["AGENT_INITIALIZE_FAILED", "连接检查未完成，请检查程序或启动设置后重试"],
  [
    "AGENT_INITIALIZE_TIMEOUT",
    "连接检查超时，原因尚未确定。请先查看是否有待处理的登录或文件夹访问提示，再检查程序启动设置",
  ],
  ["AGENT_CONNECTION_ENDED", "连接在检查完成前结束，请检查程序后重试"],
  ["AGENT_START_FAILED", "程序未能启动，请检查程序文件和资料文件夹后重试"],
  [
    "AGENT_OPEN_TIMEOUT",
    "打开对话尚未确认完成，等待已超时。原内容已保留，请先查看是否有待处理的提示。",
  ],
  [
    "AGENT_OPEN_CLOSED",
    "打开对话尚未确认完成，未能取得结果。原内容已保留，请检查连接后重试。",
  ],
  ["AGENT_OPEN_WAIT_CANCELLED", "已取消等待读取。原内容已保留。"],
  [
    "AGENT_WORK_DIRECTORY_UNAVAILABLE",
    "工作文件夹不存在或无法访问，请恢复后重试。原内容已保留。",
  ],
] as const;

it.each(failures)(
  "presents only the fixed explanation for %s",
  (code, text) => {
    expect(uiError(code, "连接失败")).toBe(text);
    expect(uiError(new Error(code), "安装未完成")).toBe(text);
  },
);

it.each(failures)(
  "rejects decorated or embedded %s without exposing its payload",
  (code) => {
    for (const reason of [
      `${code}: secret-canary`,
      `${code} secret-canary`,
      `${code}\nsecret-canary`,
      `${code}\0secret-canary`,
      `prefix:${code}`,
      `${code}_OTHER`,
      `检查结果：${code}: secret-canary`,
      `Error: 检查结果：${code}: secret-canary`,
      `检查结果：${code.toLowerCase()}: secret-canary`,
      ` ${code}`,
      `${code} `,
      `Error:\n${code}`,
      `Error:  ${code}`,
      new Error(`${code}: secret-canary`),
      { code, message: "secret-canary" },
    ]) {
      const text = uiError(reason, "安装未完成");
      expect(text).toBe("安装未完成");
      expect(text).not.toContain("secret-canary");
    }
  },
);

it("keeps unknown diagnostics behind the caller's fallback", () => {
  for (const reason of [
    "AGENT_UNKNOWN_FAILURE",
    "initialize failed: secret-canary",
    "agent process exited during initialize",
    "toString",
    "__proto__",
  ]) {
    expect(uiError(reason, "连接失败")).toBe("连接失败");
  }
});

it("retains authentication and short app-authored error explanations", () => {
  expect(uiError("AUTH_REQUIRED", "连接失败")).toBe(
    STRINGS.access.authRequired,
  );
  expect(uiError(new Error("AUTH_REQUIRED"), "连接失败")).toBe(
    STRINGS.access.authRequired,
  );
  expect(uiError("请先选择资料文件夹", "连接失败")).toBe("请先选择资料文件夹");
});

it("keeps startup explanations free of product-forbidden terminology", () => {
  const forbidden =
    /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i;
  for (const [code] of failures)
    expect(uiError(code, "失败")).not.toMatch(forbidden);
});
