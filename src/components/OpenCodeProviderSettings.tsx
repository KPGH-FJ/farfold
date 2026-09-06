import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import {
  openCodeAuthProviders,
  changeOpenCodeAuth,
  type OpenCodeAuthProvider,
} from "../runtime/opencode";

interface Props {
  running: boolean;
  taskLocked: boolean;
  canStart: boolean;
  onStart: () => Promise<void>;
  onApply: () => Promise<void>;
  onClose: () => void;
}

export function OpenCodeProviderSettings({
  running,
  taskLocked,
  canStart,
  onStart,
  onApply,
  onClose,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [providers, setProviders] = useState<OpenCodeAuthProvider[]>([]);
  const [selected, setSelected] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const locked = busy || loading || taskLocked;
  const provider = providers.find((item) => item.id === selected);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    if (!running) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void openCodeAuthProviders()
      .then((items) => {
        if (cancelled) return;
        setProviders(items);
        setSelected((current) =>
          items.some((item) => item.id === current) ? current : "",
        );
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [running]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await onStart();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function change(action: "save_api_key" | "remove") {
    if (locked || !provider || (action === "save_api_key" && !apiKey.trim()))
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await changeOpenCodeAuth(
        action === "save_api_key"
          ? { action, providerId: provider.id, apiKey }
          : { action, providerId: provider.id },
      );
      setApiKey("");
      setConfirmingRemove(false);
      const result = action === "remove" ? "保存的认证已移除" : "认证已保存";
      setNotice(`${result}，正在重新连接 OpenCode…`);
      try {
        await onApply();
        setProviders(await openCodeAuthProviders());
        setNotice(
          action === "remove"
            ? "保存的认证已移除。服务仍可能通过运行环境或免认证模型保持可用。"
            : "认证已保存。请选择模型并完成一次任务，验证请求是否可用。",
        );
      } catch (reason) {
        setNotice(
          `${result}，但重新连接未完成。关闭设置后可重新打开当前对话。`,
        );
        setError(String(reason));
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="connection-settings opencode-provider-settings"
      aria-labelledby="opencode-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div>
          <span className="settings-eyebrow">OpenCode</span>
          <h2 id="opencode-settings-title">连接模型服务</h2>
          <p>API key 由 OpenCode 保存，仅用于此 Farfold 环境。</p>
        </div>
        <button
          className="settings-close"
          disabled={busy}
          onClick={onClose}
          aria-label="关闭 OpenCode 设置"
        >
          <X size={17} />
        </button>
      </header>
      <div className="opencode-provider-form">
        {!running ? (
          <>
            <p>先在选定项目中启动 OpenCode，再配置模型服务。</p>
            <button disabled={!canStart || locked} onClick={() => void start()}>
              启动 OpenCode
            </button>
            {!canStart && <p>关闭设置并选择项目文件夹后即可开始。</p>}
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!confirmingRemove) void change("save_api_key");
            }}
          >
            <p>
              此处使用 API key 认证。OAuth
              和需要额外参数的连接暂不能在本页完成。
            </p>
            <label>
              模型服务
              <select
                value={selected}
                disabled={locked}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setApiKey("");
                  setNotice(null);
                  setError(null);
                  setConfirmingRemove(false);
                }}
              >
                <option value="">
                  {loading ? "正在读取服务列表…" : "选择模型服务"}
                </option>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.connected ? " · 已配置" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                disabled={locked || !provider || confirmingRemove}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="输入此服务的 API key"
              />
            </label>
            {provider?.connected && (
              <p>保存将替换此服务在当前 Farfold 环境中的已有认证。</p>
            )}
            {taskLocked && <p>请等待当前任务结束后修改认证。</p>}
            <button
              type="submit"
              disabled={
                locked || !provider || !apiKey.trim() || confirmingRemove
              }
            >
              {busy ? "正在处理…" : "保存并重新连接"}
            </button>
            {provider?.connected &&
              (confirmingRemove ? (
                <div className="opencode-auth-removal">
                  <p>
                    移除“{provider.name}”在此 Farfold
                    环境中保存的认证？对话与项目文件会保留。
                  </p>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => void change("remove")}
                  >
                    确认移除认证
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmingRemove(false)}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setConfirmingRemove(true)}
                >
                  移除保存的认证
                </button>
              ))}
          </form>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
