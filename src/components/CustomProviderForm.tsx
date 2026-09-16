import { useState } from "react";
import { ArrowLeft, FloppyDisk, Info } from "@phosphor-icons/react";
import type { CustomProviderInput } from "../runtime/capabilities";

interface CustomProviderFormProps {
  busy: boolean;
  onCancel: () => void;
  onSave: (input: CustomProviderInput) => Promise<void>;
}

const initialInput: CustomProviderInput = {
  providerId: "local-openai",
  providerName: "Local OpenAI",
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
  modelId: "",
  modelName: "",
  contextWindow: 128_000,
  maxTokens: 8_192,
  reasoning: false,
  imageInput: false,
  localKeyless: true,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
};

export function CustomProviderForm({
  busy,
  onCancel,
  onSave,
}: CustomProviderFormProps) {
  const [value, setValue] = useState(initialInput);
  const [error, setError] = useState<string | null>(null);
  const valid =
    value.providerId.trim() &&
    value.baseUrl.trim() &&
    value.modelId.trim() &&
    value.contextWindow > 0 &&
    value.maxTokens > 0;

  function update<Key extends keyof CustomProviderInput>(
    key: Key,
    next: CustomProviderInput[Key],
  ) {
    setValue((current) => ({ ...current, [key]: next }));
  }

  return (
    <main className="connection-detail custom-provider-form">
      <button
        className="custom-provider-back"
        onClick={onCancel}
        disabled={busy}
      >
        <ArrowLeft size={15} />
        返回 Provider
      </button>
      <div className="custom-provider-heading">
        <span>Advanced</span>
        <h3>自定义或本地模型</h3>
        <p>
          保存到当前 Farfold 环境的 Pi 模型配置。这里只提供常用字段，
          实际模型与连接行为由 Pi 处理。
        </p>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          void onSave(value).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }}
      >
        <fieldset disabled={busy}>
          <legend>Provider</legend>
          <div className="custom-provider-grid">
            <label>
              <span>Provider ID</span>
              <input
                value={value.providerId}
                onChange={(event) => update("providerId", event.target.value)}
                placeholder="local-openai"
                spellCheck={false}
              />
            </label>
            <label>
              <span>显示名称</span>
              <input
                value={value.providerName}
                onChange={(event) => update("providerName", event.target.value)}
                placeholder="Local OpenAI"
              />
            </label>
            <label className="custom-provider-wide">
              <span>Base URL</span>
              <input
                type="url"
                value={value.baseUrl}
                onChange={(event) => update("baseUrl", event.target.value)}
                placeholder="http://localhost:11434/v1"
                spellCheck={false}
              />
            </label>
            <label className="custom-provider-wide">
              <span>Pi API adapter</span>
              <select
                value={value.api}
                onChange={(event) =>
                  update(
                    "api",
                    event.target.value as CustomProviderInput["api"],
                  )
                }
              >
                <option value="openai-completions">openai-completions</option>
                <option value="openai-responses">openai-responses</option>
                <option value="anthropic-messages">anthropic-messages</option>
                <option value="google-generative-ai">
                  google-generative-ai
                </option>
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset disabled={busy}>
          <legend>Model</legend>
          <div className="custom-provider-grid">
            <label>
              <span>Model ID</span>
              <input
                value={value.modelId}
                onChange={(event) => update("modelId", event.target.value)}
                placeholder="qwen2.5-coder:7b"
                spellCheck={false}
              />
            </label>
            <label>
              <span>显示名称</span>
              <input
                value={value.modelName}
                onChange={(event) => update("modelName", event.target.value)}
                placeholder="可留空，默认使用 Model ID"
              />
            </label>
            <label>
              <span>Context window</span>
              <input
                type="number"
                min="1"
                step="1"
                value={value.contextWindow}
                onChange={(event) =>
                  update("contextWindow", Number(event.target.value))
                }
              />
            </label>
            <label>
              <span>Max output tokens</span>
              <input
                type="number"
                min="1"
                step="1"
                value={value.maxTokens}
                onChange={(event) =>
                  update("maxTokens", Number(event.target.value))
                }
              />
            </label>
          </div>
          <div className="custom-provider-checks">
            <label>
              <input
                type="checkbox"
                checked={value.reasoning}
                onChange={(event) => update("reasoning", event.target.checked)}
              />
              支持 reasoning
            </label>
            <label>
              <input
                type="checkbox"
                checked={value.imageInput}
                onChange={(event) => update("imageInput", event.target.checked)}
              />
              支持图像输入
            </label>
          </div>
        </fieldset>

        <fieldset disabled={busy}>
          <legend>连接与兼容</legend>
          <div className="custom-provider-checks stacked">
            <label>
              <input
                type="checkbox"
                checked={value.localKeyless}
                onChange={(event) =>
                  update("localKeyless", event.target.checked)
                }
              />
              本地服务不校验 API key
            </label>
            <label>
              <input
                type="checkbox"
                checked={value.supportsDeveloperRole}
                onChange={(event) =>
                  update("supportsDeveloperRole", event.target.checked)
                }
              />
              服务支持 developer role
            </label>
            <label>
              <input
                type="checkbox"
                checked={value.supportsReasoningEffort}
                onChange={(event) =>
                  update("supportsReasoningEffort", event.target.checked)
                }
              />
              服务支持 reasoning_effort
            </label>
          </div>
          {!value.localKeyless && (
            <div className="custom-provider-note">
              <Info size={15} />
              保存后从 Provider 列表进入 Pi 的 API key 流程；密钥不会写入
              models.json。
            </div>
          )}
        </fieldset>

        {error && <p className="auth-error">{error}</p>}
        <div className="custom-provider-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy || !valid}>
            <FloppyDisk size={15} />
            {busy ? "保存并让 Pi 验证…" : "保存到 Pi"}
          </button>
        </div>
      </form>
    </main>
  );
}
