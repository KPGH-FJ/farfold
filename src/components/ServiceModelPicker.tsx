import { useId, useRef } from "react";
import type { Credential, ServiceCapability } from "../runtime/credentials";
import { apiConfigurationState } from "../runtime/service_capability";
import { STRINGS } from "../runtime/strings";
import { R5_SERVICE_STRINGS as S } from "../runtime/r5_service_strings";
import { availableServices, type ServiceChoice } from "./ServicePicker";

/** A selected service does not imply any model; only a user choice completes it. */
export function ServiceModelPicker({
  value,
  items,
  capability,
  error,
  onChange,
  onRetry,
  disabled = false,
}: {
  value: ServiceChoice | null;
  items: Credential[];
  capability: ServiceCapability | null;
  error: boolean;
  onChange: (value: ServiceChoice | null) => void;
  onRetry: () => void;
  disabled?: boolean;
}) {
  const selectId = useId();
  const state = apiConfigurationState(capability);
  const service = availableServices(items, capability).find(
    (item) => item.id === value?.id && item.revision === value.revision,
  );
  const selectable =
    !!service && !!value && service.models.includes(value.model);
  const selected =
    value?.model && !selectable
      ? JSON.stringify(["unavailable", value.id, value.model, value.revision])
      : (value?.model ?? "");
  const blocked = disabled || error || !service || state !== "supported";
  const context = JSON.stringify([blocked, value, service?.models]);
  const currentContext = useRef(context);
  currentContext.current = context;
  if (state === "unsupported") return null;
  return (
    <div className="service-picker service-model-picker">
      <label className="pick-label" htmlFor={selectId}>
        {S.model}
      </label>
      <select
        id={selectId}
        className="custom-input"
        value={selected}
        disabled={blocked}
        onChange={(event) => {
          if (
            blocked ||
            currentContext.current !== context ||
            !service ||
            !event.target.value ||
            !service.models.includes(event.target.value)
          )
            return;
          onChange({
            id: service.id,
            revision: service.revision,
            model: event.target.value,
          });
        }}
      >
        <option value="" disabled>
          {S.chooseModel}
        </option>
        {service?.models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        {value?.model && !selectable && (
          <option value={selected} disabled>
            {value.model} · {STRINGS.service.unavailable}
          </option>
        )}
      </select>
      <p className="agent-setup-note" role={error ? "alert" : "status"}>
        {error
          ? STRINGS.service.loadFailed
          : state === "unknown"
            ? STRINGS.common.loading
            : !service
              ? S.unavailable
              : value?.model && !selectable
                ? S.modelUnavailable
                : S.modelHint}
      </p>
      {error && (
        <button className="btn btn-text" onClick={onRetry}>
          {STRINGS.service.retry}
        </button>
      )}
    </div>
  );
}
