/** The existing workspace model/effort fields, shared without changing Direct semantics. */
export function CodexModelFields({
  models,
  modelId,
  effort,
  disabled,
  effortDisabled,
  onModel,
  onEffort,
}: {
  models: {
    id: string;
    model: string;
    displayName: string;
    supportedReasoningEfforts: { reasoningEffort: string }[];
  }[];
  modelId: string;
  effort: string;
  disabled: boolean;
  effortDisabled: boolean;
  onModel: (id: string) => void;
  onEffort: (effort: string) => void;
}) {
  const model = models.find((m) => m.id === modelId);
  return (
    <>
      <label>
        Codex 模型
        <select
          value={modelId}
          disabled={disabled}
          onChange={(e) => onModel(e.target.value)}
        >
          <option value="">请选择模型</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} · {m.model}
            </option>
          ))}
        </select>
      </label>
      <label>
        推理选项
        <select
          value={effort}
          disabled={effortDisabled}
          onChange={(e) => onEffort(e.target.value)}
        >
          <option value="">请选择推理选项</option>
          {model?.supportedReasoningEfforts.map((e) => (
            <option key={e.reasoningEffort} value={e.reasoningEffort}>
              {e.reasoningEffort}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
