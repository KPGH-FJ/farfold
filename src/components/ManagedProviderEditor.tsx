import { useEffect, useRef, useState } from "react";
import { FloppyDisk } from "@phosphor-icons/react";
import {
  correctOrdinaryZhipuDeveloperRole,
  isOrdinaryZhipuChatCompletionsEndpoint,
  listManagedProviderConnections,
  normalizeManagedProviderCompatibility,
  tryNormalizeManagedProviderEndpoint,
  type ManagedProviderConnectionSummary,
  type ManagedProviderInput,
} from "../runtime/managed-provider";

interface Props {
  busy: boolean;
  taskLocked: boolean;
  saveLabel: string;
  useSavedLabel: string;
  useSavedDisabled?: boolean;
  onSave: (input: ManagedProviderInput) => Promise<void>;
  onUseSaved?: (connection: ManagedProviderConnectionSummary) => Promise<void>;
  onCancel: () => void;
}

const initialValue: ManagedProviderInput = {
  providerKey: "openai",
  label: "OpenAI",
  accountLabel: "default",
  endpoint: "https://api.openai.com/v1",
  apiKind: "openai-chat-completions",
  apiKey: "",
  modelId: "",
  modelName: "",
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
  imageInput: false,
  supportsDeveloperRole: true,
  supportsReasoningEffort: false,
};

// Presentation and read-only connection discovery. Callers retain save/apply/create semantics.
export function ManagedProviderEditor({
  busy,
  taskLocked,
  saveLabel,
  useSavedLabel,
  useSavedDisabled = false,
  onSave,
  onUseSaved,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [connections, setConnections] = useState<
    ManagedProviderConnectionSummary[]
  >([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const listRevision = useRef(0);
  const locked = busy || taskLocked || pending;
  const endpoint = tryNormalizeManagedProviderEndpoint(value.endpoint);
  const developerRoleForcedOff =
    value.apiKind === "openai-chat-completions" &&
    isOrdinaryZhipuChatCompletionsEndpoint(value.endpoint);
  const selectedConnection = connections.find(
    (item) => item.providerConnectionId === selected,
  );
  const selectedNeedsZhipuCorrection = Boolean(
    selectedConnection?.currentConfigVersionId &&
    selectedConnection.apiKind === "openai-chat-completions" &&
    selectedConnection.supportsDeveloperRole &&
    isOrdinaryZhipuChatCompletionsEndpoint(selectedConnection.endpoint),
  );
  const valid = Boolean(
    value.providerKey.trim() &&
    value.label.trim() &&
    value.accountLabel.trim() &&
    endpoint.ok &&
    value.modelId.trim() &&
    value.apiKey.trim() &&
    Number.isSafeInteger(value.contextWindow) &&
    value.contextWindow > 0 &&
    Number.isSafeInteger(value.maxTokens) &&
    value.maxTokens > 0,
  );

  function applyConnections(items: ManagedProviderConnectionSummary[]) {
    if (!mounted.current) return;
    setConnections(items);
    setSelected((current) =>
      items.some((item) => item.providerConnectionId === current)
        ? current
        : (items[0]?.providerConnectionId ?? ""),
    );
  }
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const revision = ++listRevision.current;
    void listManagedProviderConnections()
      .then((items) => {
        if (!cancelled && revision === listRevision.current)
          applyConnections(items);
      })
      .catch((reason) => {
        if (!cancelled && revision === listRevision.current)
          setError(String(reason));
      })
      .finally(() => {
        if (!cancelled && revision === listRevision.current) setLoading(false);
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      listRevision.current += 1;
    };
  }, []);

  async function run(operation: () => Promise<void>) {
    if (locked || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  function update<Key extends keyof ManagedProviderInput>(
    key: Key,
    next: ManagedProviderInput[Key],
  ) {
    setValue((current) =>
      normalizeManagedProviderCompatibility({ ...current, [key]: next }),
    );
  }

  return (
    <main className="connection-detail custom-provider-form">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          const submitted = normalizeManagedProviderCompatibility({ ...value });
          void run(async () => {
            await onSave(submitted);
            if (!mounted.current) return;
            setValue((current) => ({ ...current, apiKey: "" }));
            // A pre-save read must not replace the saved version or revive a cleared list.
            const revision = ++listRevision.current;
            setLoading(true);
            try {
              const items = await listManagedProviderConnections();
              if (mounted.current && revision === listRevision.current)
                applyConnections(items);
            } catch (reason) {
              if (!mounted.current || revision !== listRevision.current) return;
              applyConnections([]);
              setError(`连接已保存，但列表刷新失败：${String(reason)}`);
            } finally {
              if (mounted.current && revision === listRevision.current)
                setLoading(false);
            }
          });
        }}
      >
        {onUseSaved && (
          <fieldset disabled={locked || loading}>
            <legend>已保存连接</legend>
            <div className="custom-provider-grid">
              <label className="custom-provider-wide">
                <span>连接</span>
                <select
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {!connections.length && (
                    <option value="">
                      {loading ? "正在读取" : "尚无共享连接"}
                    </option>
                  )}
                  {connections.map((connection) => (
                    <option
                      key={connection.providerConnectionId}
                      value={connection.providerConnectionId}
                    >
                      {connection.label} / {connection.accountLabel} /{" "}
                      {connection.modelId}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="custom-provider-actions">
              {selectedNeedsZhipuCorrection && selectedConnection && (
                <button
                  type="button"
                  disabled={locked || loading}
                  onClick={() => {
                    void run(async () => {
                      await correctOrdinaryZhipuDeveloperRole({
                        providerConnectionId:
                          selectedConnection.providerConnectionId,
                        providerConfigVersionId:
                          selectedConnection.currentConfigVersionId!,
                      });
                      const revision = ++listRevision.current;
                      setLoading(true);
                      try {
                        const items = await listManagedProviderConnections();
                        if (
                          mounted.current &&
                          revision === listRevision.current
                        )
                          applyConnections(items);
                      } finally {
                        if (
                          mounted.current &&
                          revision === listRevision.current
                        )
                          setLoading(false);
                      }
                    });
                  }}
                >
                  创建 System role 兼容版本
                </button>
              )}
              <button
                type="button"
                disabled={locked || loading || useSavedDisabled || !selected}
                onClick={() => {
                  const connection = selectedConnection;
                  if (connection && !useSavedDisabled)
                    void run(() => onUseSaved(connection));
                }}
              >
                {useSavedLabel}
              </button>
            </div>
          </fieldset>
        )}
        <fieldset disabled={locked}>
          <legend>连接</legend>
          <div className="custom-provider-grid">
            {(
              [
                ["label", "连接名称"],
                ["providerKey", "Provider key"],
                ["accountLabel", "账号标识"],
                ["endpoint", "Base URL"],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className={
                  key === "endpoint" ? "custom-provider-wide" : undefined
                }
              >
                <span>{label}</span>
                <input
                  type={key === "endpoint" ? "url" : "text"}
                  value={value[key]}
                  spellCheck={key === "label"}
                  onChange={(event) => update(key, event.target.value)}
                />
              </label>
            ))}
            <label className="custom-provider-wide">
              <span>API 协议</span>
              <select
                value={value.apiKind}
                onChange={(event) =>
                  update(
                    "apiKind",
                    event.target.value as ManagedProviderInput["apiKind"],
                  )
                }
              >
                <option value="openai-chat-completions">
                  OpenAI Chat Completions
                </option>
                <option value="openai-responses">OpenAI Responses</option>
              </select>
            </label>
          </div>
        </fieldset>
        <fieldset disabled={locked}>
          <legend>模型</legend>
          <div className="custom-provider-grid">
            {(
              [
                ["modelId", "Model ID"],
                ["modelName", "显示名称"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  value={value[key]}
                  spellCheck={false}
                  onChange={(event) => update(key, event.target.value)}
                />
              </label>
            ))}
            {(
              [
                ["contextWindow", "Context"],
                ["maxTokens", "Max tokens"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={value[key]}
                  onChange={(event) => update(key, Number(event.target.value))}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={locked}>
          <legend>能力</legend>
          <div className="custom-provider-checks">
            {(
              [
                ["reasoning", "Reasoning"],
                ["imageInput", "Image input"],
                ["supportsDeveloperRole", "Developer role"],
                ["supportsReasoningEffort", "Reasoning effort"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={value[key]}
                  disabled={
                    key === "supportsDeveloperRole" && developerRoleForcedOff
                  }
                  onChange={(event) => update(key, event.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={locked}>
          <legend>凭据</legend>
          <div className="custom-provider-grid">
            <label className="custom-provider-wide">
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value.apiKey}
                onChange={(event) => update("apiKey", event.target.value)}
              />
            </label>
          </div>
        </fieldset>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <div className="custom-provider-actions">
          <button type="button" onClick={onCancel} disabled={locked}>
            取消
          </button>
          <button className="primary" type="submit" disabled={locked || !valid}>
            <FloppyDisk size={15} />
            {saveLabel}
          </button>
        </div>
      </form>
    </main>
  );
}
