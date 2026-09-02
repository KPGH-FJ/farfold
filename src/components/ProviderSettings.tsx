import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Key,
  MagnifyingGlass,
  Plus,
  PlugsConnected,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type {
  AuthNotice,
  AuthPrompt,
  AuthType,
  PiModel,
  PiProvider,
} from "../runtime/capabilities";
import type { CustomProviderInput } from "../runtime/capabilities";
import { CustomProviderForm } from "./CustomProviderForm";
import { canRestoreFocus } from "./focus";

export interface ProviderAuthFlow {
  providerId: string;
  requestId: string | null;
  prompt: { id: string; value: AuthPrompt } | null;
  notice: AuthNotice | null;
  error: string | null;
}

export interface ProviderValidation {
  state: "verified-success" | "verified-failure";
  checkedAt: number;
  modelName?: string;
  error?: string;
}

interface ProviderSettingsProps {
  providers: PiProvider[];
  preferredProvider?: string | null;
  activeModel: PiModel | null;
  orphanCredentials: Array<{ providerId: string; type: AuthType }>;
  customProviderIds: string[];
  validations: Record<string, ProviderValidation>;
  busy: boolean;
  taskLocked: boolean;
  refreshing: boolean;
  testingProvider: string | null;
  authFlow: ProviderAuthFlow | null;
  onClose: () => void;
  onLogin: (providerId: string, authType: AuthType) => void;
  onAuthResponse: (requestId: string, promptId: string, value: string) => void;
  onCancelLogin: (requestId: string) => void;
  onDismissAuth: () => void;
  onTestConnection: (providerId: string) => void;
  onSaveCustom: (input: CustomProviderInput) => Promise<void>;
  onLogout: (providerId: string) => Promise<void>;
  onRefresh: () => void;
}

function statusCopy(
  provider: PiProvider,
  validation: ProviderValidation | undefined,
): string {
  if (!provider.configured) return "未配置";
  if (validation?.state === "verified-success") return "本次运行请求验证成功";
  if (validation?.state === "verified-failure") return "本次运行请求验证失败";
  if (provider.source === "environment") {
    return provider.sourceLabel || "由运行环境提供";
  }
  if (provider.credentialType === "oauth") return "OAuth 已配置 · 未验证";
  return "已配置 · 未验证";
}

export function ProviderSettings({
  providers,
  preferredProvider,
  activeModel,
  orphanCredentials,
  customProviderIds,
  validations,
  busy,
  taskLocked,
  refreshing,
  testingProvider,
  authFlow,
  onClose,
  onLogin,
  onAuthResponse,
  onCancelLogin,
  onDismissAuth,
  onTestConnection,
  onSaveCustom,
  onLogout,
  onRefresh,
}: ProviderSettingsProps) {
  const initialProvider =
    providers.find((provider) => provider.id === preferredProvider)?.id ??
    providers.find((provider) => provider.configured)?.id ??
    providers[0]?.id ??
    "";
  const [selectedId, setSelectedId] = useState(initialProvider);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const authInput = useRef<HTMLInputElement>(null);
  const closeHandler = useRef(onClose);
  const modalLock = useRef({ busy, authFlow: authFlow !== null });
  closeHandler.current = onClose;
  modalLock.current = { busy, authFlow: authFlow !== null };
  const selected =
    providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const visibleProviders = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return providers
      .filter(
        (provider) =>
          !normalized ||
          `${provider.name} ${provider.id}`
            .toLocaleLowerCase()
            .includes(normalized),
      )
      .sort((left, right) => {
        if (left.id === preferredProvider) return -1;
        if (right.id === preferredProvider) return 1;
        if (left.configured !== right.configured) {
          return Number(right.configured) - Number(left.configured);
        }
        return left.name.localeCompare(right.name);
      });
  }, [preferredProvider, providers, query]);
  const selectedFlow = authFlow?.providerId === selected?.id ? authFlow : null;
  const validation = selected ? validations[selected.id] : undefined;
  const testing = testingProvider === selected?.id;
  const locked = busy || taskLocked || selectedFlow !== null;

  useEffect(() => {
    setAnswer("");
    setConfirmingRemove(false);
  }, [selectedId, selectedFlow?.prompt?.id]);

  useEffect(() => {
    authInput.current?.focus();
  }, [selectedFlow?.prompt?.id]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusTimer = window.setTimeout(() => {
      const first = dialog.current?.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
      );
      (searchInput.current ?? first)?.focus();
    }, 0);

    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!modalLock.current.busy && !modalLock.current.authFlow) {
          event.preventDefault();
          closeHandler.current();
        }
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]",
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleDialogKeys);
      window.setTimeout(() => {
        const fallback = document.querySelector<HTMLElement>(
          "[data-provider-settings-trigger]",
        );
        (canRestoreFocus(previousFocus) ? previousFocus : fallback)?.focus();
      }, 0);
    };
  }, []);

  if (!selected) {
    return (
      <div className="settings-overlay" role="presentation">
        <section
          ref={dialog}
          className="connection-settings connection-settings-empty"
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-settings-title"
        >
          <header>
            <div>
              <span className="settings-eyebrow">Connections</span>
              <h2 id="provider-settings-title">Provider</h2>
              <p>Pi Provider 目录尚未载入。</p>
            </div>
            <button
              className="settings-close"
              onClick={onClose}
              aria-label="关闭"
            >
              <X size={17} />
            </button>
          </header>
          <div className="connection-empty-state">
            <PlugsConnected size={24} />
            <strong>无法显示 Provider</strong>
            <span>
              检查 capability bridge 后重试，不会回退到 Farfold 私有列表。
            </span>
            <button onClick={onRefresh} disabled={refreshing}>
              {refreshing ? "正在重试…" : "重新载入"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  function answerPrompt(value = answer) {
    const prompt = selectedFlow?.prompt;
    const requestId = selectedFlow?.requestId;
    if (!prompt || !requestId || !value.trim()) return;
    onAuthResponse(requestId, prompt.id, value);
  }

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && !authFlow)
          onClose();
      }}
    >
      <section
        ref={dialog}
        className="connection-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-settings-title"
      >
        <header>
          <div>
            <span className="settings-eyebrow">Connections</span>
            <h2 id="provider-settings-title">Provider</h2>
            <p>Provider、登录方式和凭据状态直接来自 Pi 0.84.3。</p>
          </div>
          <div className="settings-header-actions">
            <button onClick={onRefresh} disabled={refreshing || busy}>
              {refreshing ? "刷新中…" : "刷新"}
            </button>
            <button
              className="settings-close"
              onClick={onClose}
              disabled={busy || authFlow !== null}
              aria-label="关闭 Provider 设置"
            >
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="connection-settings-body">
          <aside className="connection-sidebar">
            <label>
              <MagnifyingGlass size={15} />
              <input
                ref={searchInput}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 Provider"
                aria-label="搜索 Provider"
              />
            </label>
            <nav aria-label="Provider 列表">
              {visibleProviders.map((provider) => (
                <button
                  className={provider.id === selected.id ? "selected" : ""}
                  key={provider.id}
                  onClick={() => setSelectedId(provider.id)}
                  disabled={busy || authFlow !== null}
                >
                  <span className="provider-monogram">
                    {provider.name.slice(0, 1).toLocaleUpperCase()}
                  </span>
                  <span>
                    <strong>{provider.name}</strong>
                    <small>
                      {provider.id}
                      {customProviderIds.includes(provider.id)
                        ? " · custom"
                        : ""}
                    </small>
                  </span>
                  <i
                    className={
                      validations[provider.id]?.state === "verified-success"
                        ? "verified"
                        : validations[provider.id]?.state === "verified-failure"
                          ? "failed"
                          : provider.configured
                            ? "configured"
                            : ""
                    }
                    aria-label={statusCopy(provider, validations[provider.id])}
                  />
                </button>
              ))}
            </nav>
            <button
              className="custom-provider-entry"
              onClick={() => setCustomOpen(true)}
              disabled={busy || authFlow !== null || taskLocked}
            >
              <Plus size={15} />
              自定义或本地模型
            </button>
          </aside>

          {customOpen ? (
            <CustomProviderForm
              busy={busy}
              onCancel={() => setCustomOpen(false)}
              onSave={async (inputValue) => {
                await onSaveCustom(inputValue);
                setSelectedId(inputValue.providerId);
                setCustomOpen(false);
              }}
            />
          ) : (
            <main className="connection-detail">
              <div className="connection-heading">
                <span className="provider-mark">
                  {selected.name.slice(0, 1)}
                </span>
                <div>
                  <h3>{selected.name}</h3>
                  <p>
                    <span
                      className={`provider-status-dot${
                        validation?.state === "verified-success"
                          ? " verified"
                          : validation?.state === "verified-failure"
                            ? " failed"
                            : selected.configured
                              ? " configured"
                              : ""
                      }`}
                    />
                    {statusCopy(selected, validation)}
                  </p>
                </div>
                {validation?.state === "verified-success" ? (
                  <CheckCircle size={21} weight="fill" />
                ) : validation?.state === "verified-failure" ? (
                  <WarningCircle size={21} weight="fill" />
                ) : null}
              </div>

              <div className="connection-facts">
                <span>
                  <small>模型</small>
                  <strong>{selected.modelCount}</strong>
                </span>
                <span>
                  <small>凭据来源</small>
                  <strong>
                    {selected.sourceLabel || selected.source || "—"}
                  </strong>
                </span>
              </div>

              {taskLocked && (
                <div className="connection-lock-note">
                  Pi
                  正在执行任务。为了不改变当前请求的凭据，连接操作将在任务停止后开放。
                </div>
              )}

              {selected.configured && !selectedFlow && (
                <section
                  className={`connection-validation ${validation?.state ?? "unverified"}`}
                >
                  <div>
                    <strong>
                      {validation?.state === "verified-success"
                        ? "连接可用"
                        : validation?.state === "verified-failure"
                          ? "连接验证失败"
                          : "已配置，尚未验证"}
                    </strong>
                    <small>
                      {validation?.state === "verified-success"
                        ? `本次运行已通过 ${validation.modelName ?? "Pi 模型"} 完成真实请求`
                        : validation?.state === "verified-failure"
                          ? `本次运行：${validation.error || "Provider 拒绝了测试请求"}`
                          : "点击后会发起一次最多 4 token 的真实请求，可能产生少量费用。"}
                    </small>
                  </div>
                  <button
                    onClick={() => onTestConnection(selected.id)}
                    disabled={locked || testing}
                  >
                    {testing && <CircleNotch size={15} className="spin" />}
                    {testing ? "测试中…" : "测试连接"}
                  </button>
                </section>
              )}

              {selectedFlow ? (
                <section className="auth-flow">
                  <header>
                    <span>Pi 登录</span>
                    <small>
                      {selectedFlow.notice?.type === "progress"
                        ? selectedFlow.notice.message
                        : "进行中"}
                    </small>
                  </header>

                  {selectedFlow.notice?.type === "auth_url" && (
                    <div className="auth-url-notice">
                      <ArrowSquareOut size={17} />
                      <span>
                        <strong>已在系统浏览器打开登录页</strong>
                        <small>
                          {selectedFlow.notice.instructions ||
                            selectedFlow.notice.url}
                        </small>
                      </span>
                    </div>
                  )}

                  {selectedFlow.notice?.type === "device_code" && (
                    <div className="device-code">
                      <span>设备验证码</span>
                      <strong>{selectedFlow.notice.userCode}</strong>
                      <small>{selectedFlow.notice.verificationUri}</small>
                    </div>
                  )}

                  {selectedFlow.notice?.type === "info" && (
                    <p className="auth-info">{selectedFlow.notice.message}</p>
                  )}

                  {selectedFlow.prompt?.value.type === "select" ? (
                    <div className="auth-options">
                      <p>{selectedFlow.prompt.value.message}</p>
                      {selectedFlow.prompt.value.options.map((option) => (
                        <button
                          key={option.id}
                          onClick={() => answerPrompt(option.id)}
                        >
                          <span>
                            <strong>{option.label}</strong>
                            {option.description && (
                              <small>{option.description}</small>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : selectedFlow.prompt ? (
                    <form
                      className="auth-prompt"
                      onSubmit={(event) => {
                        event.preventDefault();
                        answerPrompt();
                      }}
                    >
                      <label>
                        <span>{selectedFlow.prompt.value.message}</span>
                        <div>
                          <Key size={16} />
                          <input
                            ref={authInput}
                            type={
                              selectedFlow.prompt.value.type === "secret"
                                ? "password"
                                : "text"
                            }
                            value={answer}
                            onChange={(event) => setAnswer(event.target.value)}
                            placeholder={
                              selectedFlow.prompt.value.placeholder ||
                              "输入 Pi 请求的信息"
                            }
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </div>
                      </label>
                      <button type="submit" disabled={!answer.trim()}>
                        继续
                      </button>
                    </form>
                  ) : (
                    <div className="auth-waiting">等待 Pi 完成登录…</div>
                  )}

                  {selectedFlow.error && (
                    <p className="auth-error">{selectedFlow.error}</p>
                  )}
                  {selectedFlow.requestId ? (
                    <button
                      className="cancel-auth"
                      onClick={() => onCancelLogin(selectedFlow.requestId!)}
                    >
                      取消登录
                    </button>
                  ) : selectedFlow.error ? (
                    <button className="cancel-auth" onClick={onDismissAuth}>
                      关闭
                    </button>
                  ) : null}
                </section>
              ) : (
                <section className="auth-methods">
                  <header>
                    <strong>连接方式</strong>
                    <small>由 {selected.name} 的 Pi Provider 定义</small>
                  </header>
                  {selected.methods.map((method) => (
                    <button
                      key={method.type}
                      disabled={locked || !method.interactive}
                      onClick={() => onLogin(selected.id, method.type)}
                    >
                      <span className="auth-method-icon">
                        {method.type === "oauth" ? (
                          <PlugsConnected size={18} />
                        ) : (
                          <Key size={18} />
                        )}
                      </span>
                      <span>
                        <strong>{method.label || method.name}</strong>
                        <small>
                          {method.interactive
                            ? method.type === "oauth"
                              ? "使用系统浏览器完成 Pi OAuth"
                              : "按照 Pi 的字段要求配置"
                            : "请在 Pi 支持的环境或配置文件中设置"}
                        </small>
                      </span>
                    </button>
                  ))}
                </section>
              )}

              <div className="connection-footer">
                <p>
                  Farfold
                  不读取回填已保存的密钥。保存后仅表示已配置；真实请求成功才代表可用。
                </p>
                {selected.credentialType &&
                  (confirmingRemove ? (
                    <div className="remove-confirm">
                      <span>
                        删除 Pi 中的 {selected.credentialType} 凭据？
                        {activeModel?.provider === selected.id && (
                          <small>
                            当前 Session 正在使用 {activeModel.name}；删除后
                            Farfold 会按原 Project 与 Session 重启
                            Pi，模型可能不可用。
                          </small>
                        )}
                      </span>
                      <button
                        onClick={() => void onLogout(selected.id)}
                        disabled={busy || taskLocked}
                      >
                        确认删除
                      </button>
                      <button onClick={() => setConfirmingRemove(false)}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      className="remove-connection"
                      onClick={() => setConfirmingRemove(true)}
                      disabled={busy || taskLocked}
                    >
                      <Trash size={15} />
                      删除已存凭据
                    </button>
                  ))}
              </div>

              {orphanCredentials.length > 0 && (
                <details className="orphan-credentials">
                  <summary>
                    Pi 中另有 {orphanCredentials.length} 个未知 Provider 凭据
                  </summary>
                  <p>
                    Farfold 保留它们，不重写、不删除，也不假装能够配置未知语义。
                  </p>
                </details>
              )}
            </main>
          )}
        </div>
      </section>
    </div>
  );
}
