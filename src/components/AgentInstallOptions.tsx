import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  installationValues,
  publicModelValue,
  sameInstallationDeclaration,
  reviewedInstallationInput,
  type InstallationInput,
  type InstallationOptions,
} from "../runtime/installation_input";
import { INSTALLATION_INPUT_STRINGS as S } from "../runtime/installation_strings";
import { officialLink, type PreparationInfo } from "../runtime/preparation";
import type { AgentSetupProgress } from "./AgentSetup";

export function useInstallationReview(
  progress: AgentSetupProgress,
  onProgress: (next: AgentSetupProgress) => void,
) {
  const [info, setInfo] = useState<PreparationInfo | null>(null);
  const [valid, setValid] = useState(true);
  const live = useRef({ info, valid, progress });
  live.current = { info, valid, progress };
  const read = () => {
    const current = live.current;
    return !current.info ||
      !current.valid ||
      current.progress.installationInputInvalid
      ? null
      : reviewedInstallationInput(
          current.info.installationOptions,
          current.progress.installationInput,
        );
  };
  return {
    ready: read() !== null,
    read,
    onInfoChange: (next: PreparationInfo | null) => {
      live.current.info = next;
      setInfo(next);
    },
    fieldProps: {
      loaded: info !== null,
      options: info?.installationOptions,
      input: progress.installationInput,
      invalidSaved: progress.installationInputInvalid,
      onChange: (input?: InstallationInput) => {
        const next = {
          ...live.current.progress,
          installationInput: input,
          installationInputInvalid: undefined,
        };
        live.current.progress = next;
        onProgress(next);
      },
      onValidityChange: (next: boolean) => {
        live.current.valid = next;
        setValid(next);
      },
    },
  };
}

export function AgentInstallOptions({
  loaded,
  options,
  input,
  invalidSaved,
  disabled,
  onChange,
  onValidityChange,
}: {
  loaded: boolean;
  options?: InstallationOptions;
  input?: InstallationInput;
  invalidSaved?: boolean;
  disabled: boolean;
  onChange: (input?: InstallationInput) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [invalidEdits, setInvalidEdits] = useState<Record<string, string>>({});
  const [linkFailed, setLinkFailed] = useState(false);
  const callbacks = useRef({ onValidityChange });
  callbacks.current = { onValidityChange };
  const identity = JSON.stringify([options, input]);
  useEffect(() => {
    setInvalidEdits({});
    callbacks.current.onValidityChange(true);
  }, [identity]);
  const stale =
    !!input && (!options || !sameInstallationDeclaration(options, input));
  const values = options ? installationValues(options, input) : {};
  const write = (next: Record<string, string>) => {
    onChange(
      options
        ? {
            declarationId: options.declarationId,
            registryVersion: options.registryVersion,
            launch: structuredClone(options.launch),
            values: next,
          }
        : undefined,
    );
  };
  if (!options && !input && !invalidSaved) return null;
  if (!loaded)
    return (
      <section className="agent-install-options" aria-label={S.title}>
        <h4>{S.title}</h4>
        <p className="auth-note">{S.unconfirmed}</p>
        {input && (
          <p className="auth-note">
            {S.previous}：{Object.values(input.values).join(" · ")}
          </p>
        )}
      </section>
    );
  return (
    <section className="agent-install-options" aria-label={S.title}>
      <h4>{S.title}</h4>
      <p className="auth-note">{S.hint}</p>
      {(stale || invalidSaved) && (
        <p role="alert">{invalidSaved ? S.savedInvalid : S.changed}</p>
      )}
      {stale && input && (
        <p className="auth-note">
          {S.previous}：{Object.values(input.values).join(" · ")}
        </p>
      )}
      {options?.fields.map((field) => (
        <div key={field.id}>
          <label className="agent-install-field">
            <span>{field.label}</span>
            <input
              value={invalidEdits[field.id] ?? values[field.id] ?? ""}
              aria-label={field.label}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => {
                if (disabled) return;
                const value = event.target.value;
                if (value !== "" && !publicModelValue(value)) {
                  setInvalidEdits((previous) => ({
                    ...previous,
                    [field.id]: value,
                  }));
                  onValidityChange(false);
                  return;
                }
                const remaining = { ...invalidEdits };
                delete remaining[field.id];
                setInvalidEdits(remaining);
                onValidityChange(Object.keys(remaining).length === 0);
                write({ ...values, [field.id]: value });
              }}
            />
          </label>
          <p className="auth-note">
            {S.modelHint}
            {!field.required && ` ${S.inherited}`}
          </p>
          {field.catalogDefaultValue && (
            <p className="auth-note">
              {S.catalogDefault(field.catalogDefaultValue)}
            </p>
          )}
          {invalidEdits[field.id] !== undefined && (
            <p role="alert">{S.invalid}</p>
          )}
          {officialLink(field.sourceUrl) && (
            <button
              className="btn btn-text"
              onClick={() =>
                void openUrl(field.sourceUrl).catch(() => setLinkFailed(true))
              }
            >
              {S.source}
            </button>
          )}
        </div>
      ))}
      {(stale || invalidSaved) &&
        !options?.fields.some((field) => field.required) && (
          <button
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => {
              if (!disabled) {
                setInvalidEdits({});
                onValidityChange(true);
                write({});
              }
            }}
          >
            {S.useExisting}
          </button>
        )}
      {options &&
        !stale &&
        !invalidSaved &&
        !Object.keys(invalidEdits).length && (
          <>
            <p className="auth-note">{S.preview}</p>
            <pre className="agent-preparation-command">
              {JSON.stringify([
                ...options.launch.args,
                ...options.fields.flatMap((field) =>
                  values[field.id] ? [field.argument, values[field.id]] : [],
                ),
              ])}
            </pre>
            {!Object.values(values).some(Boolean) && (
              <p className="auth-note">{S.inheritedPreview}</p>
            )}
          </>
        )}
      {linkFailed && <p role="alert">{S.linkFailed}</p>}
      <p className="auth-note">{S.unchanged}</p>
    </section>
  );
}
