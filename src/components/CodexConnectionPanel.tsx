import { useEffect, useRef, useState } from "react";
import {
  codexAccountAction,
  codexAccountLabel,
  codexConnectionStatus,
  catalogMatchesConnection,
  readCodexModelCatalog,
  resetCodexConnection,
  startCodexConnection,
  stopCodexConnection,
  type CodexAccountAction,
  type CodexConnectionStatus,
  type CodexModelCatalog,
} from "../runtime/codex-connection";
import type { SavedCodexInstallation } from "../runtime/codex-installation";
import {
  CodexConfigureSection,
  type CodexConfigurePresentation,
} from "./CodexConfigureSection";

type DirectProps = {
  installations: SavedCodexInstallation[];
  onConnectionChange: (installationId: string | null) => void;
};
export function CodexConnectionPanel(
  props: DirectProps | { acp: CodexConfigurePresentation },
) {
  if (!("acp" in props)) return <DirectCodexConnectionPanel {...props} />;
  const { scope, viewKey, port } = props.acp;
  return (
    <section
      className="codex-installation-result"
      aria-label="Codex 连接与账号"
    >
      <h3>连接与账号</h3>
      {scope && port.allowed ? (
        <CodexConfigureSection
          key={JSON.stringify([viewKey, scope, port.allowed])}
          scope={scope}
          port={port}
        />
      ) : (
        <p role="status">ACP 认证入口暂未开放；不会启动登录或读取凭据。</p>
      )}
    </section>
  );
}

function DirectCodexConnectionPanel({
  installations,
  onConnectionChange,
}: DirectProps) {
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(null);
  const ticket = useRef(0);

  async function run(
    label: string,
    action: () => Promise<CodexConnectionStatus | CodexModelCatalog>,
  ) {
    const current = ++ticket.current;
    setBusy(label);
    setError(null);
    try {
      const result = await action();
      if (current === ticket.current) {
        if ("models" in result) setCatalog(result);
        else setStatus(result);
      }
    } catch (reason) {
      if (current !== ticket.current) return;
      setError(String(reason));
      try {
        const result = await codexConnectionStatus();
        if (current === ticket.current) setStatus(result);
      } catch {
        /* The original operation error stays visible. */
      }
    } finally {
      if (current === ticket.current) setBusy(null);
    }
  }

  useEffect(() => {
    onConnectionChange(status?.installationId ?? null);
  }, [status?.installationId, onConnectionChange]);

  useEffect(() => {
    void run("正在读取连接状态…", () => codexConnectionStatus(true));
    return () => {
      ++ticket.current;
    };
  }, []);

  useEffect(() => {
    if (busy || !status?.processRunning || !status.initialized) return;
    const current = ticket.current;
    const timer = window.setTimeout(() => {
      const refresh =
        status.loginPhase === "waiting" || status.loginPhase === "confirming";
      void codexConnectionStatus(refresh)
        .then((result) => {
          if (ticket.current === current) setStatus(result);
        })
        .catch((reason: unknown) => {
          if (ticket.current === current) {
            setError(String(reason));
            // Stop polling a failed request; the user can explicitly refresh.
            setStatus((old) =>
              old ? { ...old, initialized: false, account: null } : old,
            );
          }
        });
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [busy, status]);

  function accountAction(action: CodexAccountAction) {
    if (!status) return;
    setCatalog(null);
    void run("正在处理账号操作…", () => codexAccountAction(status, action));
  }

  const pending =
    status?.loginPhase === "waiting" ||
    status?.loginPhase === "confirming" ||
    status?.loginPhase === "unknown";
  return (
    <section
      className="codex-installation-result"
      aria-label="Codex 连接与账号"
    >
      <h3>连接与账号</h3>
      <p>
        连接使用本 Farfold 环境的专属目录。登录信息由 Codex 保存，不导入其他
        Codex 环境的账号或历史。
      </p>
      {!status?.installationId ? (
        <>
          <label>
            使用的已登记程序
            <select
              value={selected}
              disabled={busy !== null}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">请选择程序</option>
              {installations.map((entry) => (
                <option key={entry.installationId} value={entry.installationId}>
                  {entry.inspection.selectedPath}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy !== null || !selected}
            onClick={() =>
              void run("正在校验并连接 Codex…", () =>
                startCodexConnection(selected),
              )
            }
          >
            连接 Codex
          </button>
          {error && selected && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run("正在重置连接重试状态…", async () => {
                  await resetCodexConnection(selected);
                  return codexConnectionStatus();
                })
              }
            >
              重置重试状态
            </button>
          )}
        </>
      ) : (
        <>
          <p>
            {status.processRunning
              ? status.initialized
                ? "Codex 连接已就绪"
                : "进程存在，连接状态需核对"
              : "Codex 进程已退出"}
          </p>
          <p>{codexAccountLabel(status)}</p>
          <p className="codex-installation-note">
            账号状态来自原生接口；尚未证明额度、模型请求或 Codex 任务流程可用。
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run("正在核对账号…", () => codexConnectionStatus(true))
            }
          >
            刷新账号状态
          </button>
          <button
            type="button"
            disabled={busy === "正在停止 Codex 连接…"}
            onClick={() =>
              void run("正在停止 Codex 连接…", () =>
                stopCodexConnection(status),
              )
            }
          >
            停止 Codex 连接
          </button>
          {status.initialized && (
            <>
              <button
                type="button"
                disabled={busy !== null || pending}
                onClick={() => accountAction({ type: "browser_login" })}
              >
                使用 ChatGPT 登录…
              </button>
              {pending && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => accountAction({ type: "cancel_login" })}
                >
                  取消登录
                </button>
              )}
              {status.loginPhase && (
                <p role="status">
                  {
                    {
                      waiting: "已在浏览器发起登录，等待原生回调。",
                      confirming: "登录回调已完成，正在核对账号。",
                      failed: "原生登录失败，可重新发起。",
                      canceled: "原生登录已取消。",
                      unknown:
                        "登录结果未知；请核对账号，必要时停止连接后重新发起。",
                    }[status.loginPhase]
                  }
                </p>
              )}
              <details>
                <summary>使用 API key</summary>
                <label>
                  OpenAI API key
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    disabled={busy !== null || pending}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy !== null || pending || !key.trim()}
                  onClick={() => {
                    const submitted = key;
                    setKey("");
                    accountAction({ type: "api_key", key: submitted });
                  }}
                >
                  保存到 Codex 专属环境
                </button>
              </details>
              {status.account?.account && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => accountAction({ type: "logout" })}
                >
                  退出此环境的账号
                </button>
              )}
              <details>
                <summary>原生模型目录</summary>
                <p className="codex-installation-note">
                  读取此连接公布的模型和推理选项，不发起模型任务。目录条目不代表请求已验证。
                </p>
                <button
                  type="button"
                  disabled={busy !== null || pending}
                  onClick={() => {
                    setCatalog(null);
                    void run("正在读取模型目录…", () =>
                      readCodexModelCatalog(status),
                    );
                  }}
                >
                  读取原生模型目录
                </button>
                {catalog && catalogMatchesConnection(catalog, status) && (
                  <>
                    <p>已完整读取 {catalog.models.length} 个模型</p>
                    {catalog.models.map((model) => (
                      <details key={model.id}>
                        <summary>
                          {model.displayName} · {model.model}
                        </summary>
                        <p>{model.description}</p>
                        <p>原生默认推理：{model.defaultReasoningEffort}</p>
                        <p>
                          推理选项：
                          {model.supportedReasoningEfforts
                            .map((option) => option.reasoningEffort)
                            .join("、") || "目录未提供"}
                        </p>
                        <p>
                          输入类型：
                          {model.inputModalities?.join("、") || "目录未声明"}
                        </p>
                      </details>
                    ))}
                  </>
                )}
              </details>
            </>
          )}
          <details>
            <summary>连接详情</summary>
            <p>
              {
                installations.find(
                  (entry) => entry.installationId === status.installationId,
                )?.inspection.selectedPath
              }
            </p>
            <p>{status.stateDirectory}</p>
            <p>
              原生未识别事件：{status.diagnosticCount}；超限或失效消息：
              {status.droppedEvents}
            </p>
            {status.diagnosticMethods.length > 0 && (
              <p>事件类型：{status.diagnosticMethods.join("、")}</p>
            )}
          </details>
        </>
      )}
      {busy && <p role="status">{busy}</p>}
      {(error || status?.error) && (
        <p role="alert" className="codex-installation-error">
          {error || status?.error}
        </p>
      )}
    </section>
  );
}
