import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { LockSimpleIcon } from "@phosphor-icons/react";
import {
  threads,
  configValueLabel,
  type ConfigOptionView,
  type ThreadState,
} from "../runtime/sessions";

export function isReasoningOption(option: ConfigOptionView) {
  return (
    option.category === "thought_level" ||
    (!option.category &&
      ["thought_level", "reasoning_effort"].includes(option.id))
  );
}

/** The same capability-driven control sits beside the model in both composers. */
export function ReasoningControl({ thread }: { thread: ThreadState }) {
  const option = thread.configOptions.find(isReasoningOption);
  if (!option) return null;
  const fixed = thread.identity === "established" || thread.resumed;
  if (fixed || option.type !== "select" || !option.options.length)
    return (
      <span
        className="composer-reasoning fixed"
        title={fixed ? C.reasoningFixed : option.description}
        aria-label={`${C.reasoning}：${configValueLabel(option)}`}
      >
        <span>{C.thinking}</span>
        <span>{configValueLabel(option)}</span>
        {fixed && <LockSimpleIcon size={12} />}
      </span>
    );
  return (
    <label className="composer-reasoning">
      <span>{C.thinking}</span>
      <select
        aria-label={C.reasoning}
        title={option.description}
        value={String(option.currentValue ?? "")}
        disabled={
          thread.configuring ||
          thread.running ||
          thread.submitting ||
          thread.connectionLost ||
          thread.reconnecting
        }
        onChange={(event) =>
          void threads
            .setConfig(thread.key, option.id, event.target.value)
            .catch(() => undefined)
        }
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
