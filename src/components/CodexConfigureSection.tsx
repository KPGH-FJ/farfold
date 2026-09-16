import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Globe, DeviceMobile, Key, SignOut } from "@phosphor-icons/react";
import type { CodexAcpScope } from "../runtime/codex-acp-contract";
import { codexAcpConfigureLabel } from "../runtime/codex-acp-contract";
import {
  CodexConfigurePrivateView,
  type CodexConfigurePort,
} from "../runtime/codex-acp-configure";
import { ProviderAuthPrompt } from "./ProviderAuthPrompt";

export interface CodexConfigurePresentation {
  scope: CodexAcpScope | null;
  viewKey: string;
  port: CodexConfigurePort;
}

/** Inner controls of the existing account panel; no native lifecycle authority. */
export function CodexConfigureSection({
  scope,
  port,
}: {
  scope: CodexAcpScope;
  port: CodexConfigurePort;
}) {
  const latest = useRef(port);
  latest.current = port;
  const [owner] = useState(
    () => new CodexConfigurePrivateView(scope, () => latest.current),
  );
  const state = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getSnapshot,
  );
  const [keyPrompt, setKeyPrompt] = useState(false);
  useEffect(() => {
    owner.activate();
    void owner.discover();
    return () => owner.retire();
  }, [owner]);
  const s = state.snapshot;
  const terminal = !!s && ["confirmed", "canceled", "failed"].includes(s.phase);
  const locked =
    !state.checked || state.busy || !!state.error || (!!s && !terminal);
  if (!port.allowed || !port.current())
    return <p role="status">ACP 认证入口暂未开放；不会启动登录或读取凭据。</p>;
  return (
    <>
      <p className="codex-installation-note">
        认证指令仅在当前连接视图暂存；离开不会证明原生取消或凭据回滚。
      </p>
      <div className="auth-methods">
        <button
          disabled={locked}
          onClick={() => {
            setKeyPrompt(false);
            void owner.request("browser");
          }}
        >
          <Globe size={18} />
          <span>ChatGPT 网页认证</span>
        </button>
        <button
          disabled={locked}
          onClick={() => {
            setKeyPrompt(false);
            void owner.request("device");
          }}
        >
          <DeviceMobile size={18} />
          <span>设备码认证</span>
        </button>
        <button disabled={locked} onClick={() => setKeyPrompt(true)}>
          <Key size={18} />
          <span>使用 API key</span>
        </button>
        <button
          disabled={locked}
          onClick={() => {
            setKeyPrompt(false);
            void owner.request("logout");
          }}
        >
          <SignOut size={18} />
          <span>退出此连接账号</span>
        </button>
      </div>
      {keyPrompt && !locked && (
        <ProviderAuthPrompt
          key={JSON.stringify(scope)}
          prompt={{
            id: JSON.stringify(scope),
            value: {
              type: "secret",
              message: "Codex API key",
              placeholder: "仅发送到原连接，不保存到草稿",
            },
          }}
          onReply={async (value) => {
            setKeyPrompt(false);
            await owner.request("api_key", value);
          }}
        />
      )}
      {state.busy && <p role="status">正在核对原 Configure 操作…</p>}
      {!state.checked && !state.busy && !state.error && (
        <p role="status">
          原配置仍在处理中；新认证保持关闭。
          <button onClick={() => void owner.discover()}>重新核对原操作</button>
        </p>
      )}
      {s && (
        <section className="auth-flow" aria-label="Codex Configure 私有状态">
          <header>
            <span>当前连接配置</span>
            <small role="status">{codexAcpConfigureLabel(s)}</small>
          </header>
          {s.payload?.type === "browser" && (
            <p>
              临时登录地址：
              <code style={{ overflowWrap: "anywhere" }}>
                {s.payload.authUrl}
              </code>
            </p>
          )}
          {s.payload?.type === "device" && (
            <>
              <p>
                临时验证地址：
                <code style={{ overflowWrap: "anywhere" }}>
                  {s.payload.verificationUrl}
                </code>
              </p>
              <div className="device-code">
                <span>设备验证码</span>
                <strong>{s.payload.userCode}</strong>
              </div>
            </>
          )}
          <button
            disabled={state.busy || !state.checked}
            onClick={() => void owner.request("status")}
          >
            核对原操作状态
          </button>
          {!terminal && s.phase !== "unknown" && (
            <button
              disabled={state.busy || !state.checked || s.phase === "canceling"}
              onClick={() => void owner.request("cancel")}
            >
              取消原认证操作
            </button>
          )}
          <p>模型请求、目录选择与任务能力尚未验证。</p>
        </section>
      )}
      {state.error && (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      )}
    </>
  );
}
