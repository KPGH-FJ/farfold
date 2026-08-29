import { useEffect, useRef, useState } from "react";
import { CheckCircle, Key, Trash, X } from "@phosphor-icons/react";
import type { ProviderAuthStatus } from "../runtime/pi";

interface ProviderSettingsProps {
  providers: ProviderAuthStatus[];
  preferredProvider?: string | null;
  busy: boolean;
  onClose: () => void;
  onSave: (provider: string, apiKey: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
}

function statusCopy(provider: ProviderAuthStatus): string {
  if (!provider.configured) return "未配置";
  if (provider.source === "environment") return "由环境变量提供";
  if (provider.credentialKind === "oauth") return "Pi OAuth 已配置";
  return "API Key 已配置";
}

export function ProviderSettings({
  providers,
  preferredProvider,
  busy,
  onClose,
  onSave,
  onRemove,
}: ProviderSettingsProps) {
  const initialProvider =
    providers.find((provider) => provider.id === preferredProvider)?.id ??
    providers.find((provider) => provider.configured)?.id ??
    providers[0]?.id ??
    "";
  const [selectedId, setSelectedId] = useState(initialProvider);
  const [apiKey, setApiKey] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const selected =
    providers.find((provider) => provider.id === selectedId) ?? providers[0];

  useEffect(() => {
    input.current?.focus();
  }, [selectedId]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  if (!selected) return null;

  const canRemove = selected.source === "auth_file";
  const replacingOAuth =
    selected.source === "auth_file" && selected.credentialKind === "oauth";

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="provider-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-settings-title"
      >
        <header>
          <div>
            <span className="settings-eyebrow">Provider</span>
            <h2 id="provider-settings-title">连接模型服务</h2>
            <p>
              凭据写入 Pi 原生 auth.json；已保存的 Key 不会返回界面或写入日志。
            </p>
          </div>
          <button
            className="settings-close"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭 Provider 设置"
          >
            <X size={17} />
          </button>
        </header>

        <div className="provider-settings-body">
          <nav className="provider-list" aria-label="Provider 列表">
            {providers.map((provider) => (
              <button
                className={provider.id === selected.id ? "selected" : ""}
                key={provider.id}
                onClick={() => {
                  setSelectedId(provider.id);
                  setApiKey("");
                  setConfirmingRemove(false);
                }}
                disabled={busy}
              >
                <span>{provider.name}</span>
                <i className={provider.configured ? "configured" : ""} />
              </button>
            ))}
          </nav>

          <form
            className="provider-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!apiKey.trim() || busy) return;
              void onSave(selected.id, apiKey)
                .then(() => setApiKey(""))
                .catch(() => undefined);
            }}
          >
            <div className="provider-heading">
              <div>
                <h3>{selected.name}</h3>
                <p>
                  <span
                    className={`provider-dot${selected.configured ? " configured" : ""}`}
                  />
                  {statusCopy(selected)}
                </p>
              </div>
              {selected.configured && <CheckCircle size={21} weight="fill" />}
            </div>

            <label className="api-key-field">
              <span>{selected.configured ? "替换 API Key" : "API Key"}</span>
              <div>
                <Key size={17} aria-hidden="true" />
                <input
                  ref={input}
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="粘贴 API Key"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={busy}
                  aria-describedby="api-key-note"
                />
              </div>
            </label>

            <p id="api-key-note" className="provider-note">
              {replacingOAuth
                ? "保存会将这个 Provider 的 Pi OAuth 凭据替换为 API Key。"
                : selected.source === "environment"
                  ? "当前凭据来自启动环境。保存后将改用优先级更高的 Pi auth.json。"
                  : "保存后状态为“已配置，待验证”；只有一次真实模型请求成功才算可用。"}
            </p>

            <div className="provider-actions">
              {canRemove &&
                (confirmingRemove ? (
                  <div className="remove-confirm">
                    <span>确认删除？</span>
                    <button
                      type="button"
                      onClick={() => {
                        void onRemove(selected.id).catch(() => undefined);
                      }}
                      disabled={busy}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingRemove(false)}
                      disabled={busy}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    className="remove-auth"
                    type="button"
                    onClick={() => setConfirmingRemove(true)}
                    disabled={busy}
                  >
                    <Trash size={15} />
                    删除已存凭据
                  </button>
                ))}
              <button
                className="save-auth"
                type="submit"
                disabled={!apiKey.trim() || busy}
              >
                {busy
                  ? "正在保存…"
                  : selected.configured
                    ? "保存并重启 Pi"
                    : "保存 API Key"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
