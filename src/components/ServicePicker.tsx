import { useEffect, useId, useRef, useState } from "react";
import {
  listCredentials,
  getServiceCapabilities,
  subscribeCredentialChanges,
  type Credential,
  type ServiceSelection,
  type ServiceCapability,
} from "../runtime/credentials";
import { STRINGS } from "../runtime/strings";
import { AGENT_SETUP_STRINGS as S } from "../runtime/agent_setup_strings";
import {
  apiConfigurationState,
  canUseService,
} from "../runtime/service_capability";
import { R5_SERVICE_STRINGS as R } from "../runtime/r5_service_strings";

export type ServiceChoice = ServiceSelection & { revision: string };
export interface ServicePickerData {
  items: Credential[];
  capability: ServiceCapability | null;
  error: boolean;
  onRetry: () => void;
}

export function availableServices(
  items: Credential[],
  capability: ServiceCapability | null,
): Credential[] {
  return items.filter(
    (item) =>
      !item.deleting &&
      item.complete &&
      !!item.revision &&
      canUseService(capability, item) &&
      item.models.length > 0,
  );
}

/** Select before creating a draft. Model services never reconfigure a live task. */
export function ServicePicker({
  agentId,
  value,
  onChange,
  data,
  disabled = false,
  emptyLabel = STRINGS.service.existing,
  mode = "model",
}: {
  agentId: string;
  value: ServiceChoice | null;
  onChange: (choice: ServiceChoice | null) => void;
  data?: ServicePickerData;
  disabled?: boolean;
  emptyLabel?: string;
  /** The service step confirms identity only; the model step completes it. */
  mode?: "service" | "model";
}) {
  const selectId = useId();
  const [loadedItems, setItems] = useState<Credential[]>([]);
  const [loadedCapability, setCapability] = useState<{
    agentId: string;
    value: ServiceCapability;
  } | null>(null);
  const [loadError, setError] = useState(false);
  const [revision, refresh] = useState(0);
  const items = data?.items ?? loadedItems;
  const capability = data
    ? data.capability
    : loadedCapability?.agentId === agentId
      ? loadedCapability.value
      : null;
  const apiState = apiConfigurationState(capability);
  const error = data?.error ?? loadError;
  useEffect(
    () =>
      data
        ? undefined
        : subscribeCredentialChanges(() => refresh((v) => v + 1)),
    [!!data],
  );
  useEffect(() => {
    if (data) return;
    let active = true;
    setError(false);
    setItems([]);
    setCapability(null);
    void Promise.all([listCredentials(), getServiceCapabilities(agentId)])
      .then(([records, capability]) => {
        if (!active) return;
        setItems(records);
        setCapability({ agentId, value: capability });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [agentId, revision, !!data]);
  const choices = availableServices(items, capability);
  const key = (item: Credential, model: string) =>
    mode === "service"
      ? JSON.stringify(["service", item.id, item.revision])
      : JSON.stringify([item.id, model]);
  const current = value && items.find((item) => item.id === value.id);
  const changed = !!current && current.revision !== value?.revision;
  const selectable =
    !!value &&
    choices.some(
      (item) =>
        item.id === value.id &&
        item.revision === value.revision &&
        (mode === "service" || item.models.includes(value.model)),
    );
  const selected = value
    ? selectable
      ? key(current!, value.model)
      : JSON.stringify(["unavailable", value.id, value.model, value.revision])
    : "";
  const blocked = disabled || error || apiState !== "supported";
  const context = JSON.stringify([
    agentId,
    mode,
    blocked,
    value,
    choices.map((item) => [item.id, item.revision, item.models]),
  ]);
  const currentContext = useRef(context);
  currentContext.current = context;
  if (apiState === "unsupported") return null;
  return (
    <div className="service-picker">
      <label className="pick-label" htmlFor={selectId}>
        {STRINGS.service.source}
      </label>
      <select
        id={selectId}
        className="custom-input"
        value={selected}
        disabled={blocked}
        onChange={(event) => {
          if (blocked || currentContext.current !== context) return;
          if (!event.target.value) {
            onChange(null);
            return;
          }
          const item = choices.find((c) =>
            mode === "service"
              ? key(c, "") === event.target.value
              : c.models.some((m) => key(c, m) === event.target.value),
          );
          if (item && mode === "service") {
            onChange({ id: item.id, model: "", revision: item.revision });
            return;
          }
          const model = item
            ? item.models.find((m) => key(item, m) === event.target.value)
            : undefined;
          if (item && model)
            onChange({ id: item.id, model, revision: item.revision });
        }}
      >
        <option value="">{emptyLabel}</option>
        {choices.map((item) =>
          mode === "service" ? (
            <option key={item.id} value={key(item, "")}>
              {item.label}
            </option>
          ) : (
            <optgroup key={item.id} label={item.label}>
              {item.models.map((model) => (
                <option key={model} value={key(item, model)}>
                  {model}
                </option>
              ))}
            </optgroup>
          ),
        )}
        {value && !selectable && (
          <option value={selected} disabled>
            {mode === "service" ? (current?.label ?? R.method) : value.model} ·{" "}
            {changed ? S.serviceChangedOption : STRINGS.service.unavailable}
          </option>
        )}
      </select>
      {changed && (
        <p role="status" className="auth-note">
          {S.serviceChanged}
        </p>
      )}
      {apiState === "unknown" && !error && (
        <p role="status" className="auth-note">
          {STRINGS.common.loading}
        </p>
      )}
      {error && (
        <div role="alert">
          {STRINGS.service.loadFailed}{" "}
          <button
            className="btn btn-text"
            onClick={() => (data ? data.onRetry() : refresh((v) => v + 1))}
          >
            {STRINGS.service.retry}
          </button>
        </div>
      )}
    </div>
  );
}
