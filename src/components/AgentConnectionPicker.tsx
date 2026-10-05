import { CONNECTION_STRINGS as S } from "../runtime/r5_auth_strings";

export interface ConnectionOption {
  id: string;
  title: string;
  description: string;
  disabled?: boolean;
}

/** The shared selector only records a choice; its caller owns execution. */
export function AgentConnectionPicker({
  name,
  options,
  value,
  disabled,
  onChange,
}: {
  name: string;
  options: ConnectionOption[];
  value: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="journey-methods" disabled={disabled}>
      <legend className="journey-sr-only">{S.methods}</legend>
      {options.map((option) => (
        <label className="journey-method-card" key={option.id}>
          <input
            type="radio"
            name={name}
            value={option.id}
            checked={value === option.id}
            disabled={disabled || option.disabled}
            onChange={() => {
              if (!disabled && !option.disabled) onChange(option.id);
            }}
          />
          <span>
            <strong>{option.title}</strong>
            <small>{option.description}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
