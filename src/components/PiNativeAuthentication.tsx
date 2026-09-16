import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CircleNotch, Key, Power } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PiAcpTarget } from "../runtime/pi-acp";
import {
  piNativeAuthLabel,
  piNativeAuthPending,
  readPiNativeAuthCatalog,
  requestPiNativeAuth,
  type PiNativeAuthCatalog,
  type PiNativeAuthSnapshot,
  type PiNativeAuthCommand,
} from "../runtime/pi-native-auth";
import { ProviderAuthPrompt } from "./ProviderAuthPrompt";

export function PiNativeAuthentication({
  target,
  disabled,
  onBusyChange,
  onSettled,
  onDisconnect,
}: {
  target: PiAcpTarget;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onSettled: () => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
}) {
  const [catalog, setCatalog] = useState<PiNativeAuthCatalog | null>(null);
  const [providerId, setProviderId] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [flow, setFlow] = useState<PiNativeAuthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const active = useRef(true);
  const inFlight = useRef(false);
  const currentFlow = useRef<PiNativeAuthSnapshot | null>(null);
  const callbacks = useRef({ onBusyChange, onSettled });
  callbacks.current = { onBusyChange, onSettled };
  const currentTarget = useRef(target);
  currentTarget.current = target;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      callbacks.current.onBusyChange(false);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void readPiNativeAuthCatalog(target)
      .then(
        (value) => {
          if (cancelled) return;
          setCatalog(value);
          setProviderId((current) =>
            value.providers.some((provider) => provider.id === current)
              ? current
              : (value.providers[0]?.id ?? ""),
          );
          setError(null);
        },
        () => {
          if (!cancelled) setError("Pi 原生登录目录读取失败");
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    target.farfoldSessionId,
    target.nativeSessionId,
    target.runtimeGeneration,
    reload,
  ]);

  async function request(command: PiNativeAuthCommand) {
    if (inFlight.current) return;
    const expected = currentTarget.current;
    const isCurrent = () =>
      active.current &&
      currentTarget.current.farfoldSessionId === expected.farfoldSessionId &&
      currentTarget.current.nativeSessionId === expected.nativeSessionId &&
      currentTarget.current.runtimeGeneration === expected.runtimeGeneration;
    inFlight.current = true;
    setRequesting(true);
    callbacks.current.onBusyChange(true);
    try {
      const result = await requestPiNativeAuth(expected, command);
      const current = currentTarget.current;
      if (
        !active.current ||
        current.farfoldSessionId !== expected.farfoldSessionId ||
        current.nativeSessionId !== expected.nativeSessionId ||
        current.runtimeGeneration !== expected.runtimeGeneration
      )
        return;
      if (
        result.sessionId !== expected.nativeSessionId ||
        (command.action !== "start" && result.flowId !== command.flowId)
      )
        throw new Error();
      currentFlow.current = result;
      setFlow(result);
      setError(null);
      if (result.state === "succeeded") setReload((value) => value + 1);
      try {
        await callbacks.current.onSettled();
      } catch {
        if (isCurrent()) setError("登录状态已收到，工作台状态尚未刷新。");
      }
    } catch {
      if (!isCurrent()) return;
      setError("认证操作未确认；不会自动重试，请断开并恢复当前对话。");
      // A failed status read does not authorize automatically resending a secret or another login.
      if (currentFlow.current)
        currentFlow.current = {
          ...currentFlow.current,
          state: "unknown",
          prompt: null,
          notice: null,
        };
      if (active.current) setFlow(currentFlow.current);
      try {
        await callbacks.current.onSettled();
      } catch {
        /* Keep the explicit unknown state. */
      }
    } finally {
      inFlight.current = false;
      if (isCurrent()) {
        setRequesting(false);
        callbacks.current.onBusyChange(
          piNativeAuthPending(currentFlow.current),
        );
      }
    }
  }
  const pending = piNativeAuthPending(flow);
  useEffect(() => {
    if (!pending || requesting || !flow) return;
    const timer = window.setTimeout(() => {
      void request({ action: "status", flowId: flow.flowId });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [flow, pending, requesting]);

  const provider = catalog?.providers.find((value) => value.id === providerId);
  const locked =
    disabled ||
    requesting ||
    pending ||
    flow?.state === "unknown" ||
    error !== null;
  const noticeUrl =
    flow?.notice?.type === "auth_url"
      ? flow.notice.url
      : flow?.notice?.type === "device_code"
        ? flow.notice.verificationUri
        : null;
  async function openLogin() {
    if (!noticeUrl) return;
    try {
      const url = new URL(noticeUrl);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error();
      await openUrl(url.href);
    } catch {
      setError("无法打开登录页，请核对登录状态。");
    }
  }

  return (
    <section className="pi-native-auth" aria-label="Pi 原生 Provider 认证">
      <label className="pi-native-auth-provider">
        Provider
        <select
          value={providerId}
          disabled={locked || loading}
          onChange={(event) => {
            setProviderId(event.target.value);
            setConfirmLogout(false);
          }}
        >
          {catalog?.providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
      </label>
      {loading && (
        <p role="status">
          <CircleNotch size={16} className="spin" />
          正在读取 Pi 登录方式
        </p>
      )}
      {!loading && !catalog && (
        <button
          disabled={requesting || pending}
          onClick={() => setReload((value) => value + 1)}
        >
          重新读取
        </button>
      )}
      {!flow && (
        <div className="auth-methods">
          {provider?.methods.map((method) => (
            <button
              key={method.type}
              disabled={locked}
              onClick={() =>
                void request({
                  action: "start",
                  providerId: provider!.id,
                  authType: method.type,
                })
              }
            >
              <Key size={18} />
              <span>{method.name}</span>
            </button>
          ))}
          {provider?.credentialType && (
            <div className="pi-native-logout">
              <span>
                已保存{" "}
                {provider.credentialType === "oauth" ? "OAuth" : "API key"} 凭据
                · 未验证请求
              </span>
              {confirmLogout ? (
                <>
                  <button
                    disabled={locked}
                    onClick={() => {
                      setConfirmLogout(false);
                      void request({
                        action: "start",
                        operation: "logout",
                        providerId: provider.id,
                        authType: provider.credentialType!,
                      });
                    }}
                  >
                    确认退出 {provider.name}
                  </button>
                  <button
                    disabled={locked}
                    onClick={() => setConfirmLogout(false)}
                  >
                    保留登录
                  </button>
                </>
              ) : (
                <button
                  disabled={locked}
                  onClick={() => setConfirmLogout(true)}
                >
                  退出登录
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {flow && (
        <section className="auth-flow">
          <header>
            <span>
              {flow.operation === "logout" ? "Pi 退出登录" : "Pi 原生登录"}
            </span>
            <small role="status">{piNativeAuthLabel(flow)}</small>
          </header>
          {noticeUrl && (
            <button
              className="auth-url-notice"
              onClick={() => void openLogin()}
            >
              <ArrowSquareOut size={17} />
              打开登录页
            </button>
          )}
          {flow.notice?.type === "device_code" && (
            <div className="device-code">
              <span>设备验证码</span>
              <strong>{flow.notice.userCode}</strong>
            </div>
          )}
          {(flow.notice?.type === "info" ||
            flow.notice?.type === "progress") && <p>{flow.notice.message}</p>}
          {flow.prompt && (
            <ProviderAuthPrompt
              key={`${flow.flowId}:${flow.prompt.id}`}
              prompt={flow.prompt}
              disabled={requesting || !pending}
              onReply={(value) =>
                request({
                  action: "reply",
                  flowId: flow.flowId,
                  promptId: flow.prompt!.id,
                  value,
                })
              }
            />
          )}
          {pending && (
            <button
              className="cancel-auth"
              disabled={requesting || flow.state === "cancelling"}
              onClick={() =>
                void request({ action: "cancel", flowId: flow.flowId })
              }
            >
              取消登录
            </button>
          )}
          {!pending && flow.state !== "unknown" && (
            <button
              disabled={requesting}
              onClick={() => {
                setFlow(null);
                currentFlow.current = null;
              }}
            >
              返回登录方式
            </button>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      {(pending || flow?.state === "unknown" || error !== null) && (
        <button
          className="pi-auth-disconnect"
          onClick={() => void onDisconnect()}
          title="断开 Pi 并核验恢复"
          aria-label="断开 Pi 并核验恢复"
        >
          <Power size={16} />
        </button>
      )}
    </section>
  );
}
