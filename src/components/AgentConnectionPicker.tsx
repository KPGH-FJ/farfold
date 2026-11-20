import { Fragment, type ReactNode } from "react";
import { CONNECTION_STRINGS as S } from "../runtime/r5_auth_strings";
import type { ConnectionGuidance } from "../runtime/preparation";
import { AgentConnectionGuidance } from "./AgentConnectionGuidance";

export interface ConnectionOption {
  id: string;
  title: string;
  description: string;
  disabled?: boolean;
  /** Declared method-kind label; options without it stay ungrouped. */
  group?: string;
}

/** The shared selector only records a choice; its caller owns execution. */
export function AgentConnectionPicker({
  name,
  options,
  value,
  disabled,
  groupFooters,
  guidance,
  guidanceOwner,
  onGuidanceReturn,
  apiUnavailableReason,
  onChange,
}: {
  name: string;
  options: ConnectionOption[];
  value: string | null;
  disabled: boolean;
  /** Content rendered after the last option of a group (e.g. registration). */
  groupFooters?: Partial<Record<string, ReactNode>>;
  guidance?: readonly ConnectionGuidance[];
  guidanceOwner?: string;
  onGuidanceReturn?: () => void;
  apiUnavailableReason?: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="journey-methods" disabled={disabled}>
      <legend className="journey-sr-only">{S.methods}</legend>
      {options.map((option, index) => {
        const group =
          option.group &&
          (index === 0 || options[index - 1].group !== option.group)
            ? option.group
            : null;
        const lastInGroup =
          option.group &&
          (index === options.length - 1 ||
            options[index + 1].group !== option.group);
        return (
          <Fragment key={option.id}>
            {group && <p className="journey-method-group">{group}</p>}
            <label className="journey-method-card">
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
            {lastInGroup && groupFooters?.[option.group!]}
          </Fragment>
        );
      })}
      {apiUnavailableReason && (
        <p className="auth-note">{apiUnavailableReason}</p>
      )}
      {guidance?.length ? (
        <AgentConnectionGuidance
          key={guidanceOwner}
          items={guidance}
          disabled={disabled}
          owner={guidanceOwner}
          onReturn={onGuidanceReturn}
        />
      ) : null}
    </fieldset>
  );
}
