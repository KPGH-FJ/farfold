import { invoke } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef, useState } from "react";
import { configChangeBusy } from "../runtime/protected_config";
import { threads, type ThreadState } from "../runtime/sessions";

const messages = {
  unavailable: "当前连接未提供已记住的审批规则。",
  changed: "对话或工作文件夹已变更，请从当前对话重新查看。",
  busy: "请等当前操作结束后再查看审批规则。",
  timeout: "暂时没有收到审批规则，请稍后再查看。",
  invalidResponse: "未能核对当前工作文件夹的审批规则。",
  queryFailed: "暂时无法读取审批规则。",
};

type Rule = {
  tool: string;
  pattern?: string;
  action: "allow" | "deny";
};

type Target = {
  agentId: string;
  cwd: string;
  sessionId: string;
  connectionId: string;
};

type View =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; rules: Rule[] }
  | { status: "error"; message: string };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rulesFor(value: unknown, target: Target): Rule[] | null {
  if (
    !object(value) ||
    value.connectionId !== target.connectionId ||
    value.nativeSessionId !== target.sessionId ||
    value.cwd !== target.cwd ||
    !Array.isArray(value.rules)
  ) {
    return null;
  }
  const rules: Rule[] = [];
  for (const rule of value.rules) {
    if (
      !object(rule) ||
      typeof rule.tool !== "string" ||
      !rule.tool ||
      (rule.pattern != null && typeof rule.pattern !== "string") ||
      (rule.action !== "allow" && rule.action !== "deny")
    ) {
      return null;
    }
    rules.push({
      tool: rule.tool,
      pattern: rule.pattern ?? undefined,
      action: rule.action,
    });
  }
  return rules;
}

function visibleRuleText(value: string) {
  return value.replace(
    /[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu,
    (character) => "\\u{" + character.codePointAt(0)!.toString(16) + "}",
  );
}

/** Mounted only while the current conversation's permission popover is open. */
export function PermissionRules({
  thread,
  connectionId,
}: {
  thread: ThreadState;
  connectionId: string;
}) {
  const [view, setView] = useState<View>({ status: "idle" });
  const pending = useRef<object | null>(null);
  const owner = useRef<ThreadState | null>(thread);

  useLayoutEffect(() => {
    owner.current = thread;
    setView({ status: "idle" });
    return () => {
      owner.current = null;
      pending.current = null;
    };
  }, [thread]);

  const read = async () => {
    const target = {
      agentId: thread.agentId,
      cwd: thread.cwd,
      sessionId: thread.nativeSessionId,
      connectionId,
    };
    const isCurrent = () =>
      owner.current === thread &&
      threads.thread(thread.key) === thread &&
      thread.identity === "established" &&
      thread.agentId === target.agentId &&
      thread.cwd === target.cwd &&
      thread.nativeSessionId === target.sessionId &&
      thread.connectionId === target.connectionId &&
      thread.sessionOperations?.permissionRulesRead === true;
    if (pending.current || !isCurrent() || configChangeBusy(thread)) return;

    const request = (pending.current = {});
    setView({ status: "loading" });
    try {
      const value = await invoke("session_permission_rules", target);
      if (pending.current !== request || !isCurrent()) return;
      if (configChangeBusy(thread)) {
        setView({ status: "error", message: messages.busy });
        return;
      }
      const rules = rulesFor(value, target);
      setView(
        rules
          ? { status: "ready", rules }
          : { status: "error", message: messages.invalidResponse },
      );
    } catch (error) {
      if (pending.current !== request || !isCurrent()) return;
      const code = object(error) ? error.code : undefined;
      setView({
        status: "error",
        message:
          typeof code === "string" && Object.hasOwn(messages, code)
            ? messages[code as keyof typeof messages]
            : messages.queryFailed,
      });
    } finally {
      if (pending.current === request) pending.current = null;
    }
  };

  return (
    <section aria-label="已记住的审批规则">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={view.status === "loading"}
        onClick={() => void read()}
      >
        查看已记住的审批规则
      </button>
      {view.status !== "idle" && (
        <>
          <p className="workspace-control-note">
            当前工作文件夹{" "}
            <code style={{ overflowWrap: "anywhere" }}>
              {visibleRuleText(thread.cwd)}
            </code>
          </p>
          <p className="workspace-control-note">
            以下只显示 Agent
            报告的已保存规则。同一工作文件夹的对话可共用这些规则。
          </p>
          {view.status === "loading" && <p role="status">正在读取审批规则…</p>}
          {view.status === "error" && <p role="alert">{view.message}</p>}
          {view.status === "ready" && (
            <>
              <p role="status">
                {view.rules.length
                  ? `已读取 ${view.rules.length} 条审批规则。`
                  : "Agent 未报告已保存的审批规则。"}
              </p>
              {view.rules.length > 0 && (
                <ul style={{ overflowWrap: "anywhere" }}>
                  {view.rules.map((rule, index) => (
                    <li key={index}>
                      {rule.action === "allow" ? "允许" : "拒绝"}{" "}
                      <code>{visibleRuleText(rule.tool)}</code>
                      {rule.pattern != null && (
                        <>
                          {" "}
                          · <code>{visibleRuleText(rule.pattern)}</code>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
