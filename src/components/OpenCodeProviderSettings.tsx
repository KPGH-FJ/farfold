import { useEffect, useState } from "react";
import { ProviderSettingsDialog } from "./ProviderSettingsDialog";
import {
  listManagedProviderConnections,
  saveManagedProviderApiKey,
  tryNormalizeManagedProviderEndpoint,
  type ManagedProviderConnectionSummary,
} from "../runtime/managed-provider";
import type { HostProviderProjectionSnapshot } from "../runtime/provider-projection";

interface Props {
  taskLocked: boolean;
  currentConnectionStatus?: string;
  acpManagedSessionDisabled?: boolean;
  onCreateAcpManagedSession?: (
    connection: ManagedProviderConnectionSummary,
  ) => Promise<void>;
  onProjectionUpdated?: (snapshot: HostProviderProjectionSnapshot) => void;
  onClose: () => void;
}

// OpenCode Server 认证路径已移除。ACP 模式只管理 Farfold 保存的
// OpenAI-compatible 连接；它们在新会话启动时写入私有 opencode.json。
export function OpenCodeProviderSettings({
  taskLocked,
  currentConnectionStatus,
  acpManagedSessionDisabled,
  onCreateAcpManagedSession,
  onProjectionUpdated,
  onClose,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedManagedConnections, setSavedManagedConnections] = useState<
    ManagedProviderConnectionSummary[]
  >([]);
  const [selectedManagedConnectionId, setSelectedManagedConnectionId] =
    useState("");
  const [savedManagedLoading, setSavedManagedLoading] = useState(false);
  const [shared, setShared] = useState({
    providerKey: "openai",
    label: "OpenAI",
    accountLabel: "default",
    endpoint: "https://api.openai.com/v1",
    modelId: "",
    modelName: "",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: false,
    imageInput: false,
    supportsDeveloperRole: true,
    supportsReasoningEffort: false,
    apiKey: "",
  });
  const locked = busy || taskLocked;
  const sharedEndpointValidation = tryNormalizeManagedProviderEndpoint(
    shared.endpoint,
  );

  useEffect(() => {
    let cancelled = false;
    setSavedManagedLoading(true);
    void listManagedProviderConnections()
      .then((items) => {
        if (cancelled) return;
        setSavedManagedConnections(items);
        setSelectedManagedConnectionId((current) =>
          items.some((item) => item.providerConnectionId === current)
            ? current
            : (items[0]?.providerConnectionId ?? ""),
        );
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setSavedManagedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveSharedManagedProvider() {
    if (
      locked ||
      !shared.providerKey.trim() ||
      !shared.label.trim() ||
      !shared.accountLabel.trim() ||
      !sharedEndpointValidation.ok ||
      !shared.modelId.trim() ||
      !Number.isFinite(shared.contextWindow) ||
      shared.contextWindow < 1 ||
      !Number.isFinite(shared.maxTokens) ||
      shared.maxTokens < 1 ||
      !shared.apiKey.trim()
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveManagedProviderApiKey({
        ...shared,
        apiKind: "openai-chat-completions",
      });
      onProjectionUpdated?.(saved.projectionSnapshot);
      setShared((current) => ({ ...current, apiKey: "" }));
      setSavedManagedConnections(await listManagedProviderConnections());
      setSelectedManagedConnectionId(saved.providerConnectionId);
      setNotice("连接已保存。当前会话保持原配置，可应用到新对话。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createAcpManagedSessionFromSaved() {
    const saved = savedManagedConnections.find(
      (item) => item.providerConnectionId === selectedManagedConnectionId,
    );
    if (!saved || locked || !onCreateAcpManagedSession) return;
    if (!saved.currentConfigVersionId) {
      setError(
        "这个连接缺少 Host 配置版本，不能用于新建 ACP 会话。请重新保存一次 API key。",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onCreateAcpManagedSession(saved);
      setNotice("已用保存连接新建 OpenCode ACP 会话；请求成功仍需单独验证。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ProviderSettingsDialog
      runtimeName="OpenCode"
      description="连接由 Farfold 保存，并在启动 OpenCode 时应用。"
      closeLocked={busy}
      onClose={onClose}
    >
      <div className="connection-settings-body">
        {currentConnectionStatus && (
          <p role="status">当前会话连接：{currentConnectionStatus}</p>
        )}
        <div className="opencode-provider-form">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveSharedManagedProvider();
            }}
          >
            {savedManagedConnections.length > 0 && (
              <fieldset disabled={locked || savedManagedLoading}>
                <legend>新对话连接</legend>
                <label>
                  连接
                  <select
                    value={selectedManagedConnectionId}
                    onChange={(event) =>
                      setSelectedManagedConnectionId(event.target.value)
                    }
                  >
                    {savedManagedConnections.map((item) => (
                      <option
                        key={item.providerConnectionId}
                        value={item.providerConnectionId}
                      >
                        {item.label} / {item.accountLabel} / {item.modelId}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void createAcpManagedSessionFromSaved()}
                  disabled={
                    locked ||
                    !selectedManagedConnectionId ||
                    Boolean(acpManagedSessionDisabled) ||
                    !onCreateAcpManagedSession
                  }
                >
                  应用到新对话
                </button>
              </fieldset>
            )}
            <p>当前会话保持原配置；新对话使用所选连接。</p>
            <label>
              连接名称
              <input
                value={shared.label}
                disabled={locked}
                onChange={(event) =>
                  setShared((current) => ({
                    ...current,
                    label: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Provider key
              <input
                value={shared.providerKey}
                disabled={locked}
                spellCheck={false}
                onChange={(event) =>
                  setShared((current) => ({
                    ...current,
                    providerKey: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              账号标识
              <input
                value={shared.accountLabel}
                disabled={locked}
                spellCheck={false}
                onChange={(event) =>
                  setShared((current) => ({
                    ...current,
                    accountLabel: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Base URL
              <input
                type="url"
                value={shared.endpoint}
                disabled={locked}
                spellCheck={false}
                onChange={(event) =>
                  setShared((current) => ({
                    ...current,
                    endpoint: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Model ID
              <input
                value={shared.modelId}
                disabled={locked}
                spellCheck={false}
                onChange={(event) =>
                  setShared((current) => ({
                    ...current,
                    modelId: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Context
              <input
                type="number"
                min={1}
                step={1}
                value={shared.contextWindow}
                disabled={locked}
                onChange={(event) =>
                  setShared((current) => ({
                    ...current,
                    contextWindow: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Max tokens
              <input
                type="number"
                min={1}
                step={1}
                value={shared.maxTokens}
                disabled={locked}
                onChange={(event) =>
                  setShared((current) => ({
                    ...current,
                    maxTokens: Number(event.target.value),
                  }))
                }
              />
            </label>
            <div className="provider-capability-grid">
              <label>
                Reasoning
                <input
                  type="checkbox"
                  checked={shared.reasoning}
                  disabled={locked}
                  onChange={(event) =>
                    setShared((current) => ({
                      ...current,
                      reasoning: event.target.checked,
                    }))
                  }
                />
              </label>
              <label>
                Image input
                <input
                  type="checkbox"
                  checked={shared.imageInput}
                  disabled={locked}
                  onChange={(event) =>
                    setShared((current) => ({
                      ...current,
                      imageInput: event.target.checked,
                    }))
                  }
                />
              </label>
              <label>
                Developer role
                <input
                  type="checkbox"
                  checked={shared.supportsDeveloperRole}
                  disabled={locked}
                  onChange={(event) =>
                    setShared((current) => ({
                      ...current,
                      supportsDeveloperRole: event.target.checked,
                    }))
                  }
                />
              </label>
              <label>
                Reasoning effort
                <input
                  type="checkbox"
                  checked={shared.supportsReasoningEffort}
                  disabled={locked}
                  onChange={(event) =>
                    setShared((current) => ({
                      ...current,
                      supportsReasoningEffort: event.target.checked,
                    }))
                  }
                />
              </label>
            </div>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                value={shared.apiKey}
                disabled={locked}
                spellCheck={false}
                onChange={(event) =>
                  setShared((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))
                }
              />
            </label>
            <button
              type="submit"
              disabled={
                locked ||
                !shared.providerKey.trim() ||
                !shared.accountLabel.trim() ||
                !sharedEndpointValidation.ok ||
                !shared.modelId.trim() ||
                !Number.isFinite(shared.contextWindow) ||
                shared.contextWindow < 1 ||
                !Number.isFinite(shared.maxTokens) ||
                shared.maxTokens < 1 ||
                !shared.apiKey.trim()
              }
            >
              保存共享连接
            </button>
            <p>
              {sharedEndpointValidation.ok
                ? "将保存为 Farfold 托管的独立账号连接。"
                : "请输入有效的 http/https Base URL。"}
            </p>
          </form>
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </ProviderSettingsDialog>
  );
}
