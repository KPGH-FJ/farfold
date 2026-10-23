import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserShareControls } from "./BrowserShareControls";
import type {
  BrowserShareInfo,
  BrowserSharingModel,
} from "../runtime/browser_sharing";
import type { BrowserWorkspaceState } from "../runtime/browser_workspace";

const page: BrowserWorkspaceState = {
  taskKey: "task-a",
  label: "page-a",
  revision: 2,
  phase: "ready",
  url: "https://example.org/",
};
function model(
  phase: BrowserShareInfo["phase"],
  patch: Partial<BrowserSharingModel> = {},
): BrowserSharingModel {
  return {
    queryState: "ready",
    info: {
      taskKey: page.taskKey,
      label: page.label,
      agentId: "a",
      revision: 1,
      phase,
      reason: null,
      pendingRequest: null,
    },
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: true,
    refresh: vi.fn(async () => {}),
    allow: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    ...patch,
  };
}

it("does not expose a scope confirmation or grant while merely showing the toolbar", () => {
  const sharing = model("unshared");
  const html = renderToStaticMarkup(
    <BrowserShareControls page={page} sharing={sharing} />,
  );
  expect(html).toContain("读取权限");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("标题、地址和文字");
  expect(sharing.allow).not.toHaveBeenCalled();
});

it("keeps stop available for one approved observation without claiming a lasting page grant", () => {
  const sharing = model("reading");
  const html = renderToStaticMarkup(
    <BrowserShareControls page={page} sharing={sharing} />,
  );
  expect(html).toContain("正在完成本次网页观察");
  expect(html).toContain("停止共享");
  expect(html).not.toContain("已允许读取本页");
  expect(html).not.toContain("disabled");
  expect(sharing.allow).not.toHaveBeenCalled();
});

it("explains unavailable tooling without claiming every Agent lacks support", () => {
  const html = renderToStaticMarkup(
    <BrowserShareControls page={page} sharing={model("unavailable")} />,
  );
  expect(html).toContain("此对话尚未接通网页工具");
  expect(html).toContain("仍可手动浏览网页");
  expect(html).toContain("disabled");
});

it("offers retry only for confirmed stop failure and never claims it has stopped", () => {
  const html = renderToStaticMarkup(
    <BrowserShareControls page={page} sharing={model("stop_failed")} />,
  );
  expect(html).toContain("重试停止");
  expect(html).toContain("停止尚未确认");
  expect(html).not.toContain("已停止");
  expect(html).not.toContain("disabled");
});

it("directs a pending tool request to the conversation instead of a second grant", () => {
  const pendingRequest = {
    requestId: "r",
    taskKey: page.taskKey,
    label: page.label,
    url: page.url,
    pageRevision: 2,
    phase: "awaiting_permission" as const,
  };
  const html = renderToStaticMarkup(
    <BrowserShareControls
      page={page}
      sharing={model("unshared", { pendingRequest })}
      onViewRequest={vi.fn()}
    />,
  );
  expect(html).toContain("请在对话中确认本次读取");
  expect(html).toContain("返回对话确认");
  expect(html).toContain("disabled");
});

it("keeps permission status honest until the stop response arrives", () => {
  const html = renderToStaticMarkup(
    <BrowserShareControls
      page={page}
      sharing={model("shared", { operation: "stop" })}
    />,
  );
  expect(html).toContain("正在停止共享");
  expect(html).not.toContain("已停止");
  expect(html).toContain("disabled");
});

it.each([
  ["no_session", "开始对话后可检查网页工具"],
  ["disconnected", "对话已断开"],
  ["inactive", "返回对话后可检查网页工具"],
  ["failed", "未能确认读取权限"],
] as const)("does not show endless loading for %s", (queryState, message) => {
  const html = renderToStaticMarkup(
    <BrowserShareControls
      page={page}
      sharing={model("unavailable", {
        queryState,
        info: null,
        ready: false,
      })}
    />,
  );
  expect(html).toContain(message);
  expect(html).not.toContain("正在确认读取权限");
  expect(html).toContain("disabled");
});

it.each([
  ["source_not_reviewed", "尚未核实"],
  ["unsafe_logging", "日志设置"],
  ["launch_unconfirmed", "启动条件"],
  ["preparation_failed", "准备未完成"],
  ["not_enabled_for_conversation", "没有启用"],
  ["inline_mcp_conflict", "原设置已保留"],
  ["future_reason", "此对话尚未接通"],
])(
  "uses the backend reason %s without guessing from an Agent name",
  (reason, message) => {
    const sharing = model("unavailable");
    sharing.info!.reason = reason;
    const html = renderToStaticMarkup(
      <BrowserShareControls page={page} sharing={sharing} />,
    );
    expect(html).toContain(message);
    expect(html).not.toContain("正在确认读取权限");
  },
);

it("keeps an unconfirmed stop visible while a refreshed query is pending", () => {
  const html = renderToStaticMarkup(
    <BrowserShareControls
      page={null}
      sharing={model("stop_failed", {
        queryState: "checking",
        ready: false,
      })}
    />,
  );
  expect(html).toContain("停止尚未确认");
  expect(html).not.toContain("尚未允许读取");
});
