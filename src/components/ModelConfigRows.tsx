import type { ConfigOptionView } from "../runtime/session_types";
import { configValueLabel } from "../runtime/session_projection";
import { ModelPicker } from "./ModelPicker";

/** Additional declared model choices retain their IDs and declaration order. */
export function additionalModelRows({
  options,
  primaryId,
  disabled,
  onPick,
}: {
  options: ConfigOptionView[];
  primaryId?: string;
  disabled: boolean;
  onPick: (id: string, value: string) => void;
}) {
  return options
    .filter((option) => option.category === "model" && option.id !== primaryId)
    .map((option) => (
      <div className="so-row" key={option.id}>
        <span className="so-name">{option.name}</span>
        {option.type === "select" && option.options.length ? (
          <ModelPicker
            option={option}
            disabled={disabled}
            onPick={(value) => onPick(option.id, value)}
          />
        ) : (
          <span>{configValueLabel(option)}</span>
        )}
      </div>
    ));
}
