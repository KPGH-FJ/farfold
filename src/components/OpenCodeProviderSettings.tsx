import { useEffect, useState } from "react";
import { ProviderSettingsDialog } from "./ProviderSettingsDialog";
import { ProviderCatalog } from "./ProviderCatalog";
import {
  openCodeAuthProviders,
  changeOpenCodeAuth,
  openCodeCredentialRevisionFingerprint,
  openCodeProviderConnectionId,
  type OpenCodeAuthProvider,
  type OpenCodeModelSelection,
} from "../runtime/opencode";
import {
  recordHostProviderProjection,
  upsertHostProviderConnection,
  type HostProviderProjectionSnapshot,
} from "../runtime/provider-projection";
import {
  applyManagedProviderToOpenCodeServer,
  listManagedProviderConnections,
  saveManagedProviderApiKey,
  tryNormalizeManagedProviderEndpoint,
  type ManagedProviderConnectionSummary,
} from "../runtime/managed-provider";

interface Props {
  running: boolean;
  preferredProvider?: string;
  taskLocked: boolean;
  canStart: boolean;
  runtimeInstallationId: string;
  runtimeConnectionId: string;
  usesAcp?: boolean;
  currentConnectionStatus?: string;
  selectedModel?: OpenCodeModelSelection | null;
  acpManagedSessionDisabled?: boolean;
  onStart: () => Promise<void>;
  onApply: () => Promise<void>;
  onCreateAcpManagedSession?: (
    connection: ManagedProviderConnectionSummary,
  ) => Promise<void>;
  onProjectionUpdated?: (snapshot: HostProviderProjectionSnapshot) => void;
  onClose: () => void;
}

export function OpenCodeProviderSettings({
  running,
  preferredProvider,
  taskLocked,
  canStart,
  runtimeInstallationId,
  runtimeConnectionId,
  usesAcp = false,
  currentConnectionStatus,
  selectedModel,
  acpManagedSessionDisabled,
  onStart,
  onApply,
  onCreateAcpManagedSession,
  onProjectionUpdated,
  onClose,
}: Props) {
  const [providers, setProviders] = useState<OpenCodeAuthProvider[]>([]);
  const [selected, setSelected] = useState(preferredProvider ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(running);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(usesAcp);
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
  const locked = busy || loading || taskLocked;
  const provider = providers.find((item) => item.id === selected);
  const sharedEndpointValidation = tryNormalizeManagedProviderEndpoint(
    shared.endpoint,
  );

  function nextCredentialRevision(action: "save_api_key" | "remove"): string {
    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return openCodeCredentialRevisionFingerprint(action, nonce);
  }

  useEffect(() => {
    if (!running || usesAcp) {
      setProviders([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void openCodeAuthProviders()
      .then((items) => {
        if (cancelled) return;
        setProviders(items);
        setSelected((current) =>
          items.some((item) => item.id === current) ? current : "",
        );
      })
      .catch((reason) => {
        if (!cancelled) {
          setProviders([]);
          setError(String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [running, refreshRevision, usesAcp]);

  useEffect(() => {
    if (!sharedOpen) return;
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
  }, [sharedOpen]);

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
    const credentialRevision = nextCredentialRevision(action);
    let connectionSnapshot: HostProviderProjectionSnapshot | null = null;
    const targetProjectionInput =
      selectedModel?.providerId === provider.id
        ? {
            runtimeProductId: "opencode" as const,
            installationId: runtimeInstallationId,
            runtimeConnectionId,
            runtimeProviderId: selectedModel.providerId,
            runtimeModelId: selectedModel.modelId,
            activeTaskPolicy: "current_task_keeps_bound_config" as const,
          }
        : null;
    const recordTargetFailure = async (detail: string) => {
      if (!connectionSnapshot || !targetProjectionInput) return;
      const projectionSnapshot = await recordHostProviderProjection({
        providerConnectionId:
          connectionSnapshot.connection.providerConnectionId,
        configVersionId: connectionSnapshot.connection.currentConfigVersionId,
        ...targetProjectionInput,
        saveState: "failed",
        applyState: "failed",
        requestState: "not_requested",
        requestVerifiedVersionId: null,
        detail,
      });
      onProjectionUpdated?.(projectionSnapshot);
    };
    try {
      connectionSnapshot = await upsertHostProviderConnection({
        providerConnectionId: openCodeProviderConnectionId(provider.id),
        providerKey: provider.id,
        label: provider.name,
        source: "farfold_managed",
        endpointFingerprint: `opencode:${provider.id}:private-auth`,
        credentialRevisionFingerprint: credentialRevision,
        modelMappingFingerprint:
          selectedModel?.providerId === provider.id
            ? `model:${selectedModel.modelId}`
            : "model:unselected",
      });
      onProjectionUpdated?.(connectionSnapshot);
      setNotice("正在更新 OpenCode 认证…");
      try {
        await changeOpenCodeAuth(
          action === "save_api_key"
            ? { action, providerId: provider.id, apiKey }
            : { action, providerId: provider.id },
        );
      } catch (reason) {
        await recordTargetFailure("OpenCode native auth change failed");
        throw reason;
      }
      setApiKey("");
      setConfirmingRemove(false);
      const result = action === "remove" ? "保存的认证已移除" : "认证已保存";
      setNotice(`${result}，正在重新连接 OpenCode…`);
      try {
        await onApply();
        const refreshed = await openCodeAuthProviders();
        setProviders(refreshed);
        const nativeConnected = refreshed.some(
          (item) => item.id === provider.id && item.connected,
        );
        const currentConfigVersionId =
          connectionSnapshot.connection.currentConfigVersionId;
        if (targetProjectionInput) {
          const projectionSnapshot = await recordHostProviderProjection({
            providerConnectionId:
              connectionSnapshot.connection.providerConnectionId,
            configVersionId: currentConfigVersionId,
            ...targetProjectionInput,
            saveState: action === "remove" ? "not_saved" : "saved",
            applyState:
              action === "remove"
                ? "not_applicable"
                : nativeConnected
                  ? "applied"
                  : "failed",
            requestState: "not_requested",
            requestVerifiedVersionId: null,
            detail:
              action === "remove"
                ? "OpenCode auth removed through native config"
                : nativeConnected
                  ? "OpenCode auth saved and native config reports the Provider connected"
                  : "OpenCode auth saved but native config did not report the Provider connected",
          });
          onProjectionUpdated?.(projectionSnapshot);
        }
        setNotice(
          action === "remove"
            ? "保存的认证已移除。服务仍可能通过运行环境或免认证模型保持可用。"
            : "认证已保存。请选择模型并完成一次任务，验证请求是否可用。",
        );
      } catch (reason) {
        await recordTargetFailure(
          "OpenCode reconnect failed after auth change",
        );
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
      if (!usesAcp) {
        if (
          !sharedEndpointValidation.ok ||
          sharedEndpointValidation.value !== "https://api.openai.com/v1"
        ) {
          const projection = await recordHostProviderProjection({
            providerConnectionId: saved.providerConnectionId,
            configVersionId: saved.currentConfigVersionId,
            runtimeProductId: "opencode",
            installationId: runtimeInstallationId,
            runtimeConnectionId,
            runtimeProviderId: shared.providerKey,
            runtimeModelId: shared.modelId,
            saveState: "saved",
            applyState: "failed",
            requestState: "not_requested",
            requestVerifiedVersionId: null,
            activeTaskPolicy: "current_task_keeps_bound_config",
            detail:
              "OpenCode Server native auth change cannot apply a connection-scoped custom endpoint in this slice",
          });
          onProjectionUpdated?.(projection);
          throw new Error(
            "当前 OpenCode Server 入口只能应用默认 endpoint；自定义 endpoint 已保存但尚未应用。",
          );
        }
        const operationId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const applied = await applyManagedProviderToOpenCodeServer({
          providerConnectionId: saved.providerConnectionId,
          providerConfigVersionId: saved.currentConfigVersionId,
          operationId,
          runtimeProductId: "opencode",
          installationId: runtimeInstallationId,
          runtimeConnectionId,
          runtimeProviderId: shared.providerKey,
          runtimeModelId: shared.modelId,
        });
        await onApply();
        onProjectionUpdated?.(applied.projectionSnapshot);
      }
      setNotice(
        usesAcp
          ? "连接已保存。当前会话保持原配置，可应用到新对话。"
          : "共享 Provider 已保存，并已应用到当前 OpenCode 连接。",
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function applySavedManagedProvider() {
    const saved = savedManagedConnections.find(
      (item) => item.providerConnectionId === selectedManagedConnectionId,
    );
    if (!saved || locked) return;
    if (!saved.currentConfigVersionId) {
      setError(
        "这个连接缺少 Host 配置版本，不能应用。请重新保存一次 API key。",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (saved.endpoint !== "https://api.openai.com/v1") {
        const projection = await recordHostProviderProjection({
          providerConnectionId: saved.providerConnectionId,
          configVersionId: saved.currentConfigVersionId,
          runtimeProductId: "opencode",
          installationId: runtimeInstallationId,
          runtimeConnectionId,
          runtimeProviderId: saved.providerKey,
          runtimeModelId: saved.modelId,
          saveState: "saved",
          applyState: "failed",
          requestState: "not_requested",
          requestVerifiedVersionId: null,
          activeTaskPolicy: "current_task_keeps_bound_config",
          detail:
            "OpenCode Server native auth change cannot apply a connection-scoped custom endpoint in this slice",
        });
        onProjectionUpdated?.(projection);
        throw new Error(
          "当前 OpenCode Server 入口只能应用默认 endpoint；自定义 endpoint 已保留为未应用。",
        );
      }
      const operationId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const applied = await applyManagedProviderToOpenCodeServer({
        providerConnectionId: saved.providerConnectionId,
        providerConfigVersionId: saved.currentConfigVersionId,
        operationId,
        runtimeProductId: "opencode",
        installationId: runtimeInstallationId,
        runtimeConnectionId,
        runtimeProviderId: saved.providerKey,
        runtimeModelId: saved.modelId,
      });
      await onApply();
      onProjectionUpdated?.(applied.projectionSnapshot);
      setNotice("已应用保存连接到当前 OpenCode 连接。");
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
      description={
        usesAcp
          ? "连接由 Farfold 保存，并在启动 OpenCode 时应用。"
          : "API key 由 OpenCode 保存，仅用于此 Farfold 环境。"
      }
      closeLocked={busy}
      refreshing={loading}
      refreshDisabled={busy || !running || usesAcp}
      onRefresh={() => setRefreshRevision((revision) => revision + 1)}
      onClose={onClose}
    >
      <div className="connection-settings-body">
        {currentConnectionStatus && (
          <p role="status">当前会话连接：{currentConnectionStatus}</p>
        )}
        {!usesAcp && (
          <ProviderCatalog
            items={providers.map((item) => ({
              id: item.id,
              name: item.name,
              configured: item.connected,
              status: item.connected
                ? "Runtime 已连接 · 请求未验证"
                : "Runtime 未报告连接",
              tone: item.connected ? "configured" : "",
            }))}
            selectedId={selected}
            preferredId={preferredProvider}
            disabled={locked || !running}
            loading={loading}
            onSelect={(id) => {
              setSelected(id);
              setApiKey("");
              setNotice(null);
              setError(null);
              setConfirmingRemove(false);
            }}
          />
        )}
        <div className="opencode-provider-form">
          {!usesAcp && (
            <button
              type="button"
              className="notice-action"
              disabled={locked}
              onClick={() => setSharedOpen((open) => !open)}
            >
              {sharedOpen ? "返回原生 Provider" : "共享 OpenAI-compatible"}
            </button>
          )}
          {sharedOpen ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveSharedManagedProvider();
              }}
            >
              {savedManagedConnections.length > 0 && (
                <fieldset disabled={locked || savedManagedLoading}>
                  <legend>{usesAcp ? "新对话连接" : "已保存连接"}</legend>
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
                    onClick={() =>
                      void (usesAcp
                        ? createAcpManagedSessionFromSaved()
                        : applySavedManagedProvider())
                    }
                    disabled={
                      locked ||
                      !selectedManagedConnectionId ||
                      (usesAcp &&
                        (acpManagedSessionDisabled ||
                          !onCreateAcpManagedSession))
                    }
                  >
                    {usesAcp ? "应用到新对话" : "应用已保存连接"}
                  </button>
                </fieldset>
              )}
              <p>
                {usesAcp
                  ? "当前会话保持原配置；新对话使用所选连接。"
                  : "保存一次 Farfold managed API key，并按当前 OpenCode 连接记录配置版本；真实模型请求仍需单独验证。"}
              </p>
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
          ) : !running ? (
            <>
              <p>先在选定项目中启动 OpenCode，再配置模型服务。</p>
              <button
                disabled={!canStart || locked}
                onClick={() => void start()}
              >
                启动 OpenCode
              </button>
              {!canStart && <p>关闭设置并选择项目文件夹后即可开始。</p>}
            </>
          ) : loading ? (
            <p role="status">正在读取 OpenCode 配置…</p>
          ) : !provider ? (
            <div className="connection-empty-state">
              <strong>{error ? "无法读取模型服务" : "选择模型服务"}</strong>
              <span>
                {error
                  ? "读取失败不代表尚未认证。可以刷新后重试。"
                  : "从左侧搜索并选择要配置的服务。"}
              </span>
            </div>
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
              <div className="connection-heading">
                <span className="provider-mark">
                  {provider.name.slice(0, 1)}
                </span>
                <div>
                  <h3>{provider.name}</h3>
                  <p>
                    {provider.id} ·{" "}
                    {provider.connected
                      ? "Runtime 已连接 · 请求未验证"
                      : "Runtime 未报告连接"}
                  </p>
                </div>
              </div>
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
                <p>
                  保存将设置此服务在当前 Farfold
                  环境中的认证；若已有保存的认证，则会替换。
                </p>
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
      </div>
    </ProviderSettingsDialog>
  );
}
