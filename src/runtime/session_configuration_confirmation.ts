import {
  configurationConfirmationBusy,
  sameConfigurationSnapshot,
  type ConfigCheck,
} from "./config_check";
import { captureConfigurationOwner } from "./saved_configuration_restore";
import { protectedConfigIds } from "./protected_config";
import { normalizeConfigOptions } from "./session_projection";
import { readPermissionEffect } from "./permission_effect";
import type { ConfirmedConfigUpdate } from "./session_configuration";
import type { ThreadState } from "./session_types";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const permission = (s: ThreadState) => ({
  id: s.permissionConfigId ?? null,
  state: s.permissionState,
  effect: s.permissionEffect ?? null,
});

function check(value: unknown): ConfigCheck | null {
  if (
    !object(value) ||
    value.status !== "ready" ||
    !Array.isArray(value.issues) ||
    value.issues.length ||
    !Object.hasOwn(value, "current") ||
    (value.protectedIds !== undefined &&
      (!Array.isArray(value.protectedIds) || !value.protectedIds.every(text)))
  )
    return null;
  return {
    status: "ready",
    issues: [],
    current: value.current,
    ...(value.protectedIds === undefined
      ? {}
      : { protectedIds: value.protectedIds as string[] }),
  };
}

/** Read snapshots only for comparison; never manufacture options or a service. */
function choices(current: unknown): Record<string, unknown>[] | null {
  if (!object(current)) return null;
  const entries = Array.isArray(current.choices)
    ? current.choices
    : [current.model, current.thoughtLevel].filter((value) => value != null);
  if (
    !Array.isArray(current.choices) &&
    !Object.hasOwn(current, "model") &&
    !Object.hasOwn(current, "thoughtLevel")
  )
    return null;
  if (
    !entries.every(
      (value) =>
        object(value) &&
        text(value.id) &&
        text(value.category) &&
        typeof value.value === "string",
    )
  )
    return null;
  return new Set(entries.map((value) => value.id)).size === entries.length
    ? entries
    : null;
}

function option(value: unknown): boolean {
  if (
    !object(value) ||
    !text(value.id) ||
    typeof value.name !== "string" ||
    !text(value.type) ||
    !Object.hasOwn(value, "currentValue")
  )
    return false;
  if (value.type === "boolean") return typeof value.currentValue === "boolean";
  if (value.type !== "select") return true;
  if (typeof value.currentValue !== "string" || !Array.isArray(value.options))
    return false;
  const choice = (value: unknown) =>
    object(value) &&
    typeof value.value === "string" &&
    typeof value.name === "string";
  return value.options.every(
    (value) =>
      choice(value) ||
      (object(value) &&
        typeof value.group === "string" &&
        typeof value.name === "string" &&
        Array.isArray(value.options) &&
        value.options.every(choice)),
  );
}

/** An ephemeral owner of one explicit save confirmation, never persistence. */
export class ConfigurationConfirmation {
  readonly displayed: unknown;
  private readonly initialCheck;
  private readonly sameOwner;
  private readonly initialPermission;
  private readonly source;

  constructor(
    private state: ThreadState,
    private current: () => ThreadState | undefined,
    private revision: () => number,
    private initialRevision = revision(),
  ) {
    this.displayed = structuredClone(state.configCheck!.current);
    this.initialCheck = structuredClone(state.configCheck);
    this.sameOwner = captureConfigurationOwner(state);
    this.initialPermission = structuredClone(permission(state));
    this.source = structuredClone(state.service ?? null);
  }

  ownsFeedback(): boolean {
    return this.current() === this.state && this.sameOwner();
  }

  owns(): boolean {
    return (
      this.ownsFeedback() &&
      this.revision() === this.initialRevision &&
      sameConfigurationSnapshot(
        permission(this.state),
        this.initialPermission,
      ) &&
      sameConfigurationSnapshot(this.state.configCheck, this.initialCheck) &&
      !configurationConfirmationBusy({ ...this.state, configuring: false })
    );
  }

  receipt(value: unknown, ordered: ConfigCheck | null) {
    if (!object(value) || !object(value.configuration)) return null;
    const full = check(value),
      channel = check(ordered);
    const configuration = value.configuration;
    const saved = check(configuration.configCheck);
    if (
      !full ||
      !saved ||
      (ordered !== null &&
        (!channel || !sameConfigurationSnapshot(full, channel))) ||
      !sameConfigurationSnapshot(full, saved) ||
      !sameConfigurationSnapshot(full.current, this.displayed) ||
      !Object.hasOwn(configuration, "configOptions") ||
      typeof configuration.configOptionsModern !== "boolean" ||
      !Object.hasOwn(configuration, "service")
    )
      return null;
    const reportedChoices = choices(full.current);
    if (!reportedChoices) return null;
    const raw = configuration.configOptions;
    if (raw === null) {
      if (
        configuration.configOptionsModern ||
        reportedChoices.length ||
        full.protectedIds?.length
      )
        return null;
    } else if (!Array.isArray(raw) || !raw.every(option)) return null;
    const options = normalizeConfigOptions(raw);
    const ids = options.map((option) => option.id);
    if (new Set(ids).size !== ids.length) return null;
    const protectedIds = protectedConfigIds(options, full.protectedIds);
    if (
      protectedIds.size !== reportedChoices.length ||
      reportedChoices.some((choice) => {
        const option = options.find((option) => option.id === choice.id);
        return (
          !option ||
          !protectedIds.has(option.id) ||
          option.currentValue !== choice.value ||
          (choice.type !== undefined && option.type !== choice.type)
        );
      })
    )
      return null;
    const service = configuration.service;
    if (
      this.source
        ? !object(service) ||
          service.id !== this.source.id ||
          service.fingerprint !== this.source.fingerprint ||
          !text(service.model)
        : service !== null
    )
      return null;
    const effect = readPermissionEffect(
      configuration.permissionEffect,
      typeof configuration.permissionConfigId === "string"
        ? configuration.permissionConfigId
        : undefined,
    );
    if (
      (configuration.permissionEffect != null && !effect) ||
      !sameConfigurationSnapshot(
        {
          id: configuration.permissionConfigId,
          state: configuration.permissionState,
          effect: effect ?? null,
        },
        this.initialPermission,
      )
    )
      return null;
    return {
      configuration: configuration as unknown as ConfirmedConfigUpdate,
      options,
      check: full,
    };
  }
}
