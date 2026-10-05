import { useRef } from "react";
import type { Credential, ServiceCapability } from "../runtime/credentials";
import { apiConfigurationState } from "../runtime/service_capability";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { STRINGS } from "../runtime/strings";
import {
  availableServices,
  ServicePicker,
  type ServiceChoice,
} from "./ServicePicker";
import { R5_SERVICE_STRINGS as R } from "../runtime/r5_service_strings";

/** One API preparation surface, shown only while supported or not yet known. */
export function AgentServiceSection({
  agentId,
  capability,
  error,
  items,
  value,
  onChange,
  onRetry,
  onOpenApi,
  disabled,
  readonly,
  editing = true,
  onChangeService,
  onEditService,
  onChangeMethod,
}: {
  agentId: string;
  capability: ServiceCapability | null;
  error: boolean;
  items: Credential[];
  value: ServiceChoice | null;
  onChange: (value: ServiceChoice | null) => void;
  onRetry: () => void;
  onOpenApi: () => void;
  disabled: boolean;
  readonly: boolean;
  editing?: boolean;
  onChangeService?: () => void;
  onEditService?: () => void;
  onChangeMethod?: () => void;
}) {
  const state = apiConfigurationState(capability);
  const choices = availableServices(items, capability);
  const selected = choices.find(
    (item) => item.id === value?.id && item.revision === value.revision,
  );
  const format =
    Object.entries(STRINGS.credentials.formats).find(
      ([type]) => type === selected?.apiType,
    )?.[1] ?? selected?.apiType;
  const empty = state === "supported" && !error && choices.length === 0;
  const blocked = disabled || error || state !== "supported";
  const context = JSON.stringify([
    agentId,
    blocked,
    readonly,
    editing,
    value,
    selected?.revision,
  ]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const manage = (action: (() => void) | undefined, changesSource = true) => {
    if (
      !blocked &&
      (!changesSource || !readonly) &&
      currentContext.current === context
    )
      action?.();
  };
  if (state === "unsupported") return null;
  return (
    <div className="agent-setup-api">
      {!editing && selected && (
        <>
          <div className="journey-connection-summary agent-service-summary">
            <div>
              <strong>{selected.label}</strong>
              <p>{format}</p>
            </div>
            <span>{R.selected}</span>
          </div>
          {!readonly &&
            (onChangeService || onEditService || onChangeMethod) && (
              <details className="agent-account-more">
                <summary>{R.manage}</summary>
                <p className="auth-note">{selected.endpoint}</p>
                <div className="auth-actions">
                  {onChangeService && (
                    <button
                      className="btn btn-text"
                      disabled={blocked}
                      onClick={() => manage(onChangeService)}
                    >
                      {R.changeService}
                    </button>
                  )}
                  {onEditService && (
                    <button
                      className="btn btn-text"
                      disabled={blocked}
                      onClick={() => manage(onEditService)}
                    >
                      {R.editService}
                    </button>
                  )}
                  {onChangeMethod && (
                    <button
                      className="btn btn-text"
                      disabled={blocked}
                      onClick={() => manage(onChangeMethod)}
                    >
                      {R.changeMethod}
                    </button>
                  )}
                </div>
              </details>
            )}
        </>
      )}
      {state === "supported" &&
        !error &&
        choices.length > 0 &&
        editing &&
        !readonly && (
          <ServicePicker
            agentId={agentId}
            value={value}
            onChange={onChange}
            mode="service"
            emptyLabel={R.chooseService}
            disabled={disabled}
            data={{ items, capability, error, onRetry }}
          />
        )}
      {(error ||
        state === "unknown" ||
        (!selected && (!editing || !choices.length))) && (
        <p role={error ? "alert" : "status"}>
          {error
            ? S.loadFailed
            : state === "unknown"
              ? STRINGS.common.loading
              : empty
                ? R.noServices
                : !editing
                  ? R.unavailable
                  : null}
        </p>
      )}
      {error ? (
        <button className="btn btn-ghost" onClick={onRetry}>
          {S.retry}
        </button>
      ) : state === "supported" && (editing || empty) ? (
        <button
          className={empty ? "btn btn-primary" : "btn btn-ghost"}
          disabled={blocked}
          onClick={() => manage(onOpenApi, false)}
        >
          {empty ? R.addService : S.openApi}
        </button>
      ) : null}
    </div>
  );
}
