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

export const isReasoningOption = isThoughtConfigOption;

/** The same capability-driven control sits beside the model in both composers. */
export function ReasoningControl({ thread }: { thread: ThreadState }) {
  useAuthenticationActivity(thread.agentId);
  const option = thread.configOptions.find(isReasoningOption);
  if (!option) return null;
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
          disabled={configOptionChangeBlocked(thread, option.id)}
          onClick={() => {
            if (configOptionChangeBlocked(thread, option.id)) return;
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
      <select
        aria-label={C.reasoning}
        title={option.description}
        value={String(option.currentValue ?? "")}
        disabled={configOptionChangeBlocked(thread, option.id)}
        onChange={(event) => {
          if (configOptionChangeBlocked(thread, option.id)) return;
          if (thread.identity === "draft" && pendingPreparationRead(thread))
            return;
          void threads
            .setConfig(thread.key, option.id, event.target.value)
            .catch(() => undefined);
        }}
      >
        {!option.options.some((item) => item.value === option.currentValue) && (
          <option value={String(option.currentValue ?? "")} disabled>
            {configValueLabel(option)}
          </option>
        )}
        {option.options.map((item) => (
          <option key={item.value} value={item.value}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}
