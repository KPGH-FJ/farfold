import { useEffect, useId, useState } from "react";
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

export type ServiceChoice = ServiceSelection & { revision: string };
export interface ServicePickerData {
  items: Credential[];
  capability: ServiceCapability | null;
  error: boolean;
  onRetry: () => void;
}

/** Select before creating a draft. Model services never reconfigure a live task. */
export function ServicePicker({
  agentId,
  value,
  onChange,
  data,
  disabled = false,
  emptyLabel = STRINGS.service.existing,
}: {
  agentId: string;
  value: ServiceChoice | null;
  onChange: (choice: ServiceChoice | null) => void;
  data?: ServicePickerData;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const selectId = useId();
  const [loadedItems, setItems] = useState<Credential[]>([]);
  const [loadedFormats, setFormats] = useState<string[]>([]);
  const [loadError, setError] = useState(false);
  const [loadedReason, setUnavailableReason] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const items = data?.items ?? loadedItems;
  const formats = data ? (data.capability?.apiTypes ?? []) : loadedFormats;
  const error = data?.error ?? loadError;
  const unavailableReason = data
    ? data.capability?.unavailableReason
    : loadedReason;
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
    setFormats([]);
    setUnavailableReason(null);
    void Promise.all([listCredentials(), getServiceCapabilities(agentId)])
      .then(([records, capability]) => {
        if (!active) return;
        setItems(records);
        setFormats(capability.apiTypes);
        setUnavailableReason(capability.unavailableReason);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [agentId, revision, !!data]);
  const choices = items.filter(
    (item) =>
      !item.deleting &&
      item.complete &&
      formats.includes(item.apiType) &&
      item.models.length > 0,
  );
  const key = (id: string, model: string) => JSON.stringify([id, model]);
  const current = value && items.find((item) => item.id === value.id);
  const changed = !!current && current.revision !== value?.revision;
  const selectable =
    !!value &&
    choices.some(
      (item) =>
        item.id === value.id &&
        item.revision === value.revision &&
        item.models.includes(value.model),
    );
  const selected = value
    ? selectable
      ? key(value.id, value.model)
      : JSON.stringify(["unavailable", value.id, value.model, value.revision])
    : "";
  return (
    <div className="service-picker">
      <label className="pick-label" htmlFor={selectId}>
        {STRINGS.service.source}
      </label>
      <select
        id={selectId}
        className="custom-input"
        value={selected}
        disabled={disabled}
        onChange={(event) => {
          if (!event.target.value) {
            onChange(null);
            return;
          }
          const item = choices.find((c) =>
            c.models.some((m) => key(c.id, m) === event.target.value),
          );
          const model = item?.models.find(
            (m) => key(item.id, m) === event.target.value,
          );
          if (item && model)
            onChange({ id: item.id, model, revision: item.revision });
        }}
      >
        <option value="">{emptyLabel}</option>
        {choices.map((item) => (
          <optgroup key={item.id} label={item.label}>
            {item.models.map((model) => (
              <option key={model} value={key(item.id, model)}>
                {model}
              </option>
            ))}
          </optgroup>
        ))}
        {value && !selectable && (
          <option value={selected} disabled>
            {value.model} ·{" "}
            {changed ? S.serviceChangedOption : STRINGS.service.unavailable}
          </option>
        )}
      </select>
      {changed && (
        <p role="status" className="auth-note">
          {S.serviceChanged}
        </p>
      )}
      {unavailableReason && <p className="auth-note">{unavailableReason}</p>}
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
