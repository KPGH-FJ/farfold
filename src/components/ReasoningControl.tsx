import { useState } from "react";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { ConfigurationChangeReview } from "./ConfigurationChangeReview";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { useAuthenticationActivity } from "../runtime/authentication";
import { pendingPreparationRead } from "../runtime/agent_preparation";
import {
  configOptionChangeBlocked,
  isThoughtConfigOption,
} from "../runtime/protected_config";
import { configValueLabel, type ThreadState } from "../runtime/sessions";
import { ModelPicker } from "./ModelPicker";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";

export const isReasoningOption = isThoughtConfigOption;

/** The same capability-driven control sits beside the model in both composers. */
export function ReasoningControl({
  thread,
  inactive = false,
  onApply,
}: {
  thread: ThreadState;
  /** Menus/dialogs above the composer keep the control mounted but disabled,
   *  so sibling controls do not disappear or reflow (W3-2). */
  inactive?: boolean;
  onApply?: (id: string, value: unknown) => Promise<void>;
}) {
  useAuthenticationActivity(thread.agentId);
  const [pending, setPending] = useState<{
    id: string;
    previous: unknown;
    value: unknown;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const option = thread.configOptions.find(isReasoningOption);
  if (!option) return null;
  const blocked =
    saving || inactive || configOptionChangeBlocked(thread, option.id);
  const select = (value: unknown) => {
    if (saving || inactive || configOptionChangeBlocked(thread, option.id))
      return;
    if (thread.identity === "draft" && pendingPreparationRead(thread)) return;
    setFailed(false);
    if (value === option.currentValue && onApply) {
      setPending(null);
      setSaving(true);
      void onApply(option.id, value)
        .catch(() => setFailed(true))
        .finally(() => setSaving(false));
      return;
    }
    setPending(
      value === option.currentValue
        ? null
        : { id: option.id, previous: option.currentValue, value },
    );
  };
  const review =
    !inactive &&
    pending &&
    pending.id === option.id &&
    pending.previous === option.currentValue ? (
      <WorkspaceDialog title={C.reasoning} onClose={() => setPending(null)}>
        <div className="conversation-message-editor">
          <ConfigurationChangeReview
            thread={thread}
            option={option}
            value={pending.value}
            onCancel={() => setPending(null)}
            onSaved={() => setPending(null)}
            onApply={onApply}
          />
        </div>
      </WorkspaceDialog>
    ) : null;
  if (option.type === "boolean") {
    const enabled =
      option.currentValue === true || option.currentValue === "true";
    return (
      <>
        <label className="composer-reasoning">
          <span>{C.thinking}</span>
          <button
            type="button"
            role="switch"
            aria-label={C.reasoning}
            aria-checked={enabled}
            className="so-toggle"
            disabled={blocked}
            onClick={() => {
              select(!enabled);
            }}
          />
        </label>
        {failed && <p role="alert">{R.optionSaveError}</p>}
        {review}
      </>
    );
  }
  if (option.type !== "select" || !option.options.length)
    return (
      <span
        className="composer-reasoning fixed"
        title={option.description}
        aria-label={`${C.reasoning}：${configValueLabel(option)}`}
      >
        <span>{C.thinking}</span>
        <span>{configValueLabel(option)}</span>
      </span>
    );
  return (
    <>
      <label className="composer-reasoning">
        <span>{C.thinking}</span>
        <ModelPicker
          option={option}
          label={C.reasoning}
          disabled={blocked}
          onPick={(value) => {
            select(value);
          }}
        />
      </label>
      {failed && <p role="alert">{R.optionSaveError}</p>}
      {review}
    </>
  );
}
