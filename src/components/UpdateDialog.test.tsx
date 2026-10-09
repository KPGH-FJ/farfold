import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { requestUpdateInstall, UpdateDialogContent } from "./UpdateDialog";
import type { ManagedUpdateSnapshot } from "../runtime/managed-update";
import { uiError } from "../runtime/ui_error";
import { STRINGS } from "../runtime/strings";
import { Children, isValidElement, type ReactNode } from "react";
import {
  UPDATE_IMPACT as I,
  updateConversationBlocker,
} from "../runtime/update_impact";
import { freshThreadState } from "../runtime/session_projection";

function render(snapshot: ManagedUpdateSnapshot, error: string | null = null) {
  return renderToStaticMarkup(
    <UpdateDialogContent
      snapshot={snapshot}
      pending={false}
      error={error}
      onClose={() => {}}
      onCheck={() => {}}
      onInstall={() => {}}
      onRefresh={() => {}}
    />,
  );
}
const snapshot: ManagedUpdateSnapshot = {
  configuration: "configured",
  checkStatus: "not_checked",
  installing: false,
  currentVersion: "0.1.7",
  candidate: null,
  blockers: [],
};
const candidate = {
  candidateToken: "a".repeat(64),
  currentVersion: "0.1.7",
  version: "0.1.8",
  target: "darwin-aarch64",
  notes: null,
  checkedAt: 1,
};
const restart: ManagedUpdateSnapshot = {
  ...snapshot,
  checkStatus: "available",
  candidate,
  restartPending: true,
};
function ports() {
  const calls: string[] = [];
  return {
    calls,
    hasActiveWork: vi.fn(() => true),
    lockInteraction: vi.fn((locked: boolean) => {
      calls.push(`lock:${locked}`);
    }),
    pauseQueues: vi.fn(() => {
      calls.push("pause");
    }),
    flush: vi.fn(async () => {
      calls.push("flush");
    }),
    install: vi.fn(async (_token: string) => {
      calls.push("request");
    }),
    readSnapshot: vi.fn(async () => restart),
  };
}

it("retries the same installed candidate despite stale busy work, preserving lock/pause/save order", async () => {
  const p = ports();
  const result = await requestUpdateInstall(restart, p);
  expect(result.error).toBeNull();
  expect(p.hasActiveWork).not.toHaveBeenCalled();
  expect(p.calls).toEqual(["lock:true", "pause", "flush", "request"]);
  expect(p.install).toHaveBeenCalledExactlyOnceWith(candidate.candidateToken);
  expect(result.snapshot).toMatchObject({
    installing: false,
    restartPending: true,
    candidate,
  });
});

it("still rejects first installation when actual work is active", async () => {
  const p = ports();
  p.readSnapshot.mockResolvedValue({ ...restart, restartPending: false });
  const result = await requestUpdateInstall(
    { ...restart, restartPending: false },
    p,
  );
  expect(result.error).toBe(STRINGS.update.workBlocked);
  expect(p.flush).not.toHaveBeenCalled();
  expect(p.install).not.toHaveBeenCalled();
});

it("does not request restart before the latest draft save completes", async () => {
  const p = ports();
  let save!: () => void;
  p.flush.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        save = resolve;
      }),
  );
  const request = requestUpdateInstall(restart, p);
  expect(p.lockInteraction).toHaveBeenCalledWith(true);
  expect(p.pauseQueues).toHaveBeenCalledOnce();
  expect(p.install).not.toHaveBeenCalled();
  save();
  await request;
  expect(p.install).toHaveBeenCalledExactlyOnceWith(candidate.candidateToken);
  expect(p.lockInteraction).not.toHaveBeenCalledWith(false);
});

it("keeps the installed candidate retryable after failed draft saving without sending the install command", async () => {
  const p = ports();
  p.flush.mockRejectedValue(new Error("未发送内容尚未保存，请重试后再关闭。"));
  const result = await requestUpdateInstall(restart, p);
  expect(p.install).not.toHaveBeenCalled();
  expect(p.lockInteraction).toHaveBeenLastCalledWith(false);
  expect(result.snapshot).toEqual(restart);
  const html = render(result.snapshot!, result.error);
  expect(html).toContain(STRINGS.update.restartPending);
  expect(html).toContain("未发送内容尚未保存");
  expect(html).not.toContain(STRINGS.update.installAndRestart);
});

it("presents the actual installed state after restart-event failure instead of offering another download", async () => {
  const p = ports();
  p.install.mockRejectedValue(new Error("IPC event delivery failed"));
  const result = await requestUpdateInstall(restart, p);
  expect(p.install).toHaveBeenCalledExactlyOnceWith(candidate.candidateToken);
  expect(result.snapshot).toEqual(restart);
  expect(result.error).toBe(STRINGS.update.restartRetry);
  const html = render(result.snapshot!, result.error);
  expect(html).toContain(STRINGS.update.restartPending);
  expect(html).not.toContain(STRINGS.update.installHint);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>检查更新<\/button>/);
});

it("does not manufacture an ended installation when a failure reports it is still running or cannot be read", async () => {
  const p = ports();
  p.install.mockRejectedValue(new Error("IPC failed"));
  p.readSnapshot.mockResolvedValue({
    ...restart,
    installing: true,
    restartPending: false,
  });
  const result = await requestUpdateInstall(restart, p);
  expect(result.snapshot?.installing).toBe(true);
  expect(result.error).toBe(STRINGS.update.stillInstalling);
  p.readSnapshot.mockRejectedValue(new Error("unavailable"));
  const unknown = await requestUpdateInstall(restart, p);
  expect(unknown.snapshot).toBeNull();
  expect(unknown.error).toBe(STRINGS.update.stateUnconfirmed);
});

it("only reports up to date after a configured successful check", () => {
  for (const checkStatus of ["not_checked", "checking", "failed"] as const) {
    expect(render({ ...snapshot, checkStatus })).not.toContain(
      STRINGS.update.upToDate,
    );
  }
  const unconfigured = render({
    ...snapshot,
    configuration: "unconfigured",
    blockers: ["release_infrastructure_unconfigured"],
  });
  expect(unconfigured).toContain(STRINGS.update.unconfigured);
  expect(unconfigured).not.toContain(STRINGS.update.upToDate);
  expect(render({ ...snapshot, checkStatus: "up_to_date" })).toContain(
    STRINGS.update.upToDate,
  );
  expect(render(snapshot)).toContain(STRINGS.update.notChecked);
});

it("hides stale candidates on a failed check and presents a user-facing error", () => {
  const candidate = {
    candidateToken: "a".repeat(64),
    currentVersion: "0.1.7",
    version: "0.1.8",
    target: "darwin-aarch64",
    notes: null,
    checkedAt: 1,
  };
  expect(
    render({ ...snapshot, checkStatus: "available", candidate }),
  ).toContain(STRINGS.update.installAndRestart);
  const error = uiError(
    "Managed update signature verification failed",
    STRINGS.update.checkFailed,
  );
  const failed = render(
    { ...snapshot, checkStatus: "failed", candidate },
    error,
  );
  expect(failed).not.toContain(STRINGS.update.installAndRestart);
  expect(failed).not.toContain("Managed update");
  expect(failed).toContain(STRINGS.update.checkFailed);
});

it("shows the affected conversation and returns by its exact identity without requesting an install", () => {
  const onOpen = vi.fn();
  const onInstall = vi.fn();
  const props = {
    snapshot: { ...restart, restartPending: false },
    pending: false,
    error: null,
    onClose: vi.fn(),
    onCheck: vi.fn(),
    onInstall,
    onRefresh: vi.fn(),
    impacts: [
      {
        key: "exact-key",
        title: "Affected work",
        reason: I.tools,
        blocking: true,
      },
    ],
    onOpenConversation: onOpen,
  };
  const tree = UpdateDialogContent(props);
  const visit = (node: ReactNode): void =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "button" && child.props.children === I.open)
        (child.props.onClick as () => void)();
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("exact-key");
  expect(onInstall).not.toHaveBeenCalled();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("Affected work");
  expect(html).toContain(I.tools);
  expect(html).toMatch(
    new RegExp(
      `<button[^>]*disabled=""[^>]*>${STRINGS.update.installAndRestart}</button>`,
    ),
  );
});

it("blocks a stopped reply with a still-active official tool, using the same preflight as the impact reason", async () => {
  const thread = freshThreadState("tail", "fixture", "/p", "tail");
  thread.running = false;
  thread.activeToolCallIds = ["pending-tool"];
  const p = ports();
  p.hasActiveWork.mockImplementation(() =>
    Boolean(updateConversationBlocker(thread)),
  );
  p.readSnapshot.mockResolvedValue({ ...restart, restartPending: false });
  expect(updateConversationBlocker(thread)).toBe(I.tools);
  await requestUpdateInstall({ ...restart, restartPending: false }, p);
  expect(p.install).not.toHaveBeenCalled();
  expect(p.flush).not.toHaveBeenCalled();
});

it("displays save recovery and account blockers without losing the installed candidate restart retry", () => {
  const base = {
    pending: false,
    error: null,
    onClose: vi.fn(),
    onCheck: vi.fn(),
    onInstall: vi.fn(),
    onRefresh: vi.fn(),
    accountBlocked: true,
    newDraft: true,
    saveError: "未发送内容尚未保存",
    onRetrySave: vi.fn(),
  };
  const blocked = renderToStaticMarkup(
    <UpdateDialogContent
      {...base}
      snapshot={{ ...restart, restartPending: false }}
    />,
  );
  expect(blocked).toContain(I.blocked);
  expect(blocked).toContain(I.newDraft);
  expect(blocked).toContain(I.retrySave);
  expect(blocked).toMatch(
    new RegExp(
      `<button[^>]*disabled=""[^>]*>${STRINGS.update.installAndRestart}</button>`,
    ),
  );
  const retry = renderToStaticMarkup(
    <UpdateDialogContent {...base} snapshot={restart} />,
  );
  expect(retry).toMatch(
    new RegExp(
      `<button(?![^>]*disabled)[^>]*>${STRINGS.update.restartPending}</button>`,
    ),
  );
});

it("offers actionable manual-update steps without an invented download link when no channel exists", () => {
  const html = render({
    ...snapshot,
    configuration: "unconfigured",
    blockers: ["release_infrastructure_unconfigured"],
  });
  expect(html).toContain("如何手动更新");
  expect(html).toContain("原发布渠道");
  expect(html).toContain("正常退出 Farfold");
  expect(html).not.toContain("href=");
});
