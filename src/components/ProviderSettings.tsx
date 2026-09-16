import { useEffect, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Key,
  Plus,
  PlugsConnected,
  Trash,
  WarningCircle,
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
import {
  modelValidation,
  type ProviderValidation,
} from "../runtime/provider-validation";
import { ProviderSettingsDialog } from "./ProviderSettingsDialog";
import { ProviderCatalog } from "./ProviderCatalog";
import { ManagedProviderEditor } from "./ManagedProviderEditor";
import { ProviderAuthPrompt } from "./ProviderAuthPrompt";
import {
  type ManagedProviderConnectionSummary,
  type ManagedProviderInput,
} from "../runtime/managed-provider";

export interface ProviderAuthFlow {
  providerId: string;
  requestId: string | null;
  prompt: { id: string; value: AuthPrompt } | null;
  notice: AuthNotice | null;
  error: string | null;
}

interface ProviderSettingsProps {
  providers: PiProvider[];
  preferredProvider?: string | null;
  activeModel: PiModel | null;
  models: PiModel[];
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
  onTestConnection: (providerId: string, modelId: string) => void;
  onSaveCustom: (input: CustomProviderInput) => Promise<void>;
  onSaveManaged?: (input: ManagedProviderInput) => Promise<void>;
  onApplyManagedConnection?: (
    connection: ManagedProviderConnectionSummary,
  ) => Promise<void>;
  onLogout: (providerId: string) => Promise<void>;
  onRefresh: () => void;
}

function statusCopy(
  provider: PiProvider,
  validation: ProviderValidation | undefined,
): string {
  if (!provider.configured) return "未配置";
  if (validation?.state === "verified-success")
    return `${validation.modelName ?? validation.modelId} 请求成功`;
  if (validation?.state === "verified-failure")
    return `${validation.modelName ?? validation.modelId} 请求失败`;
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
  models,
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
  onSaveManaged,
  onApplyManagedConnection,
  onLogout,
  onRefresh,
}: ProviderSettingsProps) {
  const initialProvider =
    providers.find((provider) => provider.id === preferredProvider)?.id ??
    providers.find((provider) => provider.configured)?.id ??
    providers[0]?.id ??
    "";
  const [selectedId, setSelectedId] = useState(initialProvider);
  const [probeSelections, setProbeSelections] = useState<
    Record<string, string>
  >({});
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [managedOpen, setManagedOpen] = useState(false);
  const selected =
    providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const selectedFlow = authFlow?.providerId === selected?.id ? authFlow : null;
  const probeModels = models.filter(
    (model) =>
      model.provider === selected?.id &&
      model.available &&
      model.input.includes("text"),
  );
  const preferredProbe = selected
    ? (probeSelections[selected.id] ??
      (activeModel?.provider === selected.id ? activeModel.id : ""))
    : "";
  const probeModelId = probeModels.some((model) => model.id === preferredProbe)
    ? preferredProbe
    : "";
  const validation = modelValidation(
    selected ? validations[selected.id] : undefined,
    probeModelId,
  );
  const testing = testingProvider === selected?.id;
  const locked = busy || taskLocked || selectedFlow !== null;

  useEffect(() => {
    setConfirmingRemove(false);
  }, [selectedId, selectedFlow?.prompt?.id]);

  if (!selected) {
    return (
      <ProviderSettingsDialog
        runtimeName="Pi"
        description="Pi 模型服务目录尚未载入。"
        closeLocked={busy || authFlow !== null}
        onClose={onClose}
      >
        <div className="connection-empty-state">
          <PlugsConnected size={24} />
          <strong>无法显示模型服务</strong>
          <span>请重新读取 Pi 配置；目录读取失败不代表尚未认证。</span>
          <button onClick={onRefresh} disabled={refreshing || busy}>
            {refreshing ? "正在重试…" : "重新载入"}
          </button>
        </div>
      </ProviderSettingsDialog>
    );
  }

  function answerPrompt(value: string) {
    const prompt = selectedFlow?.prompt;
    const requestId = selectedFlow?.requestId;
    if (!prompt || !requestId || !value.trim()) return;
    onAuthResponse(requestId, prompt.id, value);
  }

  return (
    <ProviderSettingsDialog
      runtimeName="Pi"
      description="登录方式与配置状态来自 Pi；已配置不代表模型请求成功。"
      closeLocked={busy || authFlow !== null}
      refreshing={refreshing}
      refreshDisabled={busy || authFlow !== null}
      onRefresh={onRefresh}
      onClose={onClose}
    >
      <div className="connection-settings-body">
        <ProviderCatalog
          items={providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            configured: provider.configured,
            status: statusCopy(provider, validations[provider.id]),
            detail: customProviderIds.includes(provider.id)
              ? "custom"
              : undefined,
            tone:
              validations[provider.id]?.state === "verified-success"
                ? "verified"
                : validations[provider.id]?.state === "verified-failure"
                  ? "failed"
                  : provider.configured
                    ? "configured"
                    : "",
          }))}
          selectedId={selected.id}
          preferredId={preferredProvider}
          disabled={busy || authFlow !== null}
          onSelect={(id) => {
            setSelectedId(id);
            setCustomOpen(false);
          }}
        >
          <button
            className="custom-provider-entry"
            onClick={() => setCustomOpen(true)}
            disabled={busy || authFlow !== null || taskLocked}
          >
            <Plus size={15} />
            自定义或本地模型
          </button>
          {onSaveManaged && (
            <button
              className="custom-provider-entry"
              onClick={() => {
                setCustomOpen(false);
                setManagedOpen(true);
              }}
              disabled={busy || authFlow !== null || taskLocked}
            >
              <Key size={15} />
              共享 OpenAI-compatible
            </button>
          )}
        </ProviderCatalog>

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
        ) : managedOpen && onSaveManaged ? (
          <ManagedProviderEditor
            busy={busy}
            taskLocked={taskLocked}
            saveLabel="保存并应用到 Pi"
            useSavedLabel="应用已保存连接"
            onSave={onSaveManaged}
            onUseSaved={onApplyManagedConnection}
            onCancel={() => setManagedOpen(false)}
          />
        ) : (
          <main className="connection-detail">
            <div className="connection-heading">
              <span className="provider-mark">{selected.name.slice(0, 1)}</span>
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
                  <label className="connection-probe-model">
                    <span>测试模型</span>
                    <select
                      aria-label="测试模型"
                      value={probeModelId}
                      disabled={locked || testing}
                      onChange={(event) =>
                        setProbeSelections((current) => ({
                          ...current,
                          [selected.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">
                        {probeModels.length
                          ? "请选择要测试的模型"
                          : "没有可测试模型，请刷新或检查配置"}
                      </option>
                      {probeModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} · {model.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <strong>
                    {validation?.state === "verified-success"
                      ? "所选模型请求成功"
                      : validation?.state === "verified-failure"
                        ? "所选模型请求失败"
                        : "已配置，尚未验证"}
                  </strong>
                  <small>
                    {validation?.state === "verified-success"
                      ? `本次运行已通过 ${validation.modelName ?? validation.modelId} 完成真实请求`
                      : validation?.state === "verified-failure"
                        ? `${validation.modelId}：${validation.error || "Provider 拒绝了测试请求"}`
                        : "点击后会发起一次最多 4 token 的真实请求，可能产生少量费用。"}
                  </small>
                </div>
                <button
                  onClick={() => onTestConnection(selected.id, probeModelId)}
                  disabled={locked || testing || !probeModelId}
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

                {selectedFlow.prompt ? (
                  <ProviderAuthPrompt
                    key={selectedFlow.prompt.id}
                    prompt={selectedFlow.prompt}
                    onReply={answerPrompt}
                  />
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
    </ProviderSettingsDialog>
  );
}
