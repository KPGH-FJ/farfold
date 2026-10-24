import { useState } from "react";
import {
  configValueLabel,
  threads,
  type ConfigOptionView,
  type ThreadState,
} from "../runtime/sessions";
import { configOptionChangeBlocked } from "../runtime/protected_config";
import { pendingPreparationRead } from "../runtime/agent_preparation";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";

/** Compare a pending selection; the actual setter remains the receipt authority. */
export function ConfigurationChangeReview({
  thread,
  option,
  value,
  onCancel,
  onSaved,
  onApply,
}: {
  thread: ThreadState;
  option: ConfigOptionView;
  value: unknown;
  onCancel: () => void;
  onSaved: () => void;
  onApply?: (id: string, value: unknown) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const blocked = saving || configOptionChangeBlocked(thread, option.id);
  const apply = async () => {
    if (
      saving ||
      configOptionChangeBlocked(thread, option.id) ||
      (thread.identity === "draft" && pendingPreparationRead(thread))
    )
      return;
    const current = thread.configOptions.find((item) => item.id === option.id);
    if (
      !current ||
      current.currentValue !== option.currentValue ||
      (current.type === "boolean"
        ? typeof value !== "boolean"
        : !current.options.some((item) => item.value === value))
    ) {
      setFailed(true);
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      await (onApply
        ? onApply(option.id, value)
        : threads.setConfig(thread.key, option.id, value));
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="conversation-option-review">
      <dl>
        <dt>{R.currentValue}</dt>
        <dd>{configValueLabel(option)}</dd>
        <dt>{R.selectedValue}</dt>
        <dd>{configValueLabel({ ...option, currentValue: value })}</dd>
      </dl>
      {failed && <p role="alert">{R.optionSaveError}</p>}
      <div>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={saving}
          onClick={onCancel}
        >
          {R.optionCancel}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={blocked}
          onClick={() => void apply()}
        >
          {saving ? R.optionChanging : R.optionChange}
        </button>
      </div>
    </div>
  );
}
