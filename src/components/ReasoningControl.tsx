import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { useAuthenticationActivity } from "../runtime/authentication";
import { pendingPreparationRead } from "../runtime/agent_preparation";
import {
  configOptionChangeBlocked,
  isThoughtConfigOption,
} from "../runtime/protected_config";
import {
  threads,
  configValueLabel,
  type ThreadState,
} from "../runtime/sessions";
import { ModelPicker } from "./ModelPicker";

export const isReasoningOption = isThoughtConfigOption;

/** The same capability-driven control sits beside the model in both composers. */
export function ReasoningControl({
  thread,
  inactive = false,
}: {
  thread: ThreadState;
  /** Menus/dialogs above the composer keep the control mounted but disabled,
   *  so sibling controls do not disappear or reflow (W3-2). */
  inactive?: boolean;
}) {
  useAuthenticationActivity(thread.agentId);
  const option = thread.configOptions.find(isReasoningOption);
  if (!option) return null;
  const blocked = inactive || configOptionChangeBlocked(thread, option.id);
  if (option.type === "boolean") {
    const enabled =
      option.currentValue === true || option.currentValue === "true";
    return (
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
            if (blocked) return;
            if (thread.identity === "draft" && pendingPreparationRead(thread))
              return;
            void threads
              .setConfig(thread.key, option.id, !enabled)
              .catch(() => undefined);
          }}
        />
      </label>
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
    <label className="composer-reasoning">
      <span>{C.thinking}</span>
      <ModelPicker
        option={option}
        label={C.reasoning}
        disabled={blocked}
        onPick={(value) => {
          if (blocked) return;
          if (thread.identity === "draft" && pendingPreparationRead(thread))
            return;
          void threads
            .setConfig(thread.key, option.id, value)
            .catch(() => undefined);
        }}
      />
    </label>
  );
}
