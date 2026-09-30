import type { AgentLaunch } from "./agents";

/** Public startup choices for a new installation, separate from session options. */
export interface InstallationInput {
  declarationId: string;
  registryVersion: string;
  launch: AgentLaunch;
  values: Record<string, string>;
}

export interface InstallationOptions {
  declarationId: string;
  registryVersion: string;
  launch: AgentLaunch;
  fields: {
    id: string;
    label: string;
    argument: string;
    valueKind: "model";
    required: boolean;
    sourceUrl: string;
    catalogDefaultValue?: string;
  }[];
  currentValues?: Record<string, string>;
}

/** Bounded public names and official references, never URLs or secret values. */
export function publicModelValue(value: string): boolean {
  if (!value || value.length > 256 || value.trim() !== value) return false;
  if (value.startsWith("$"))
    return /^\$[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/.test(value);
  return (
    /^[A-Za-z0-9][A-Za-z0-9_.:/+-]*$/.test(value) &&
    !value.includes("://") &&
    !/^sk[-_]/i.test(value)
  );
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function parseInstallationInput(
  value: unknown,
): InstallationInput | undefined {
  if (
    !object(value) ||
    !object(value.launch) ||
    !object(value.values) ||
    typeof value.declarationId !== "string" ||
    !value.declarationId ||
    typeof value.registryVersion !== "string" ||
    !value.registryVersion
  )
    return;
  const { launch } = value;
  if (
    !Array.isArray(launch.args) ||
    !launch.args.every((arg) => typeof arg === "string")
  )
    return;
  const name = launch.kind === "binary" ? launch.binary : launch.package;
  if (
    !["binary", "npx", "uvx"].includes(String(launch.kind)) ||
    typeof name !== "string" ||
    !name
  )
    return;
  if (
    Object.entries(value.values).some(
      ([id, item]) =>
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id) ||
        typeof item !== "string" ||
        (item !== "" && !publicModelValue(item)),
    )
  )
    return;
  return {
    declarationId: value.declarationId,
    registryVersion: value.registryVersion,
    launch:
      launch.kind === "binary"
        ? { kind: "binary", binary: name, args: [...launch.args] }
        : {
            kind: launch.kind as "npx" | "uvx",
            package: name,
            args: [...launch.args],
          },
    values: { ...value.values } as Record<string, string>,
  };
}

export function sameInstallationDeclaration(
  options: InstallationOptions,
  input: InstallationInput,
): boolean {
  const launchKey = (launch: AgentLaunch) =>
    JSON.stringify([
      launch.kind,
      launch.kind === "binary" ? launch.binary : launch.package,
      launch.args,
    ]);
  return (
    options.declarationId === input.declarationId &&
    options.registryVersion === input.registryVersion &&
    launchKey(options.launch) === launchKey(input.launch)
  );
}

export function installationValues(
  options: InstallationOptions,
  input?: InstallationInput,
): Record<string, string> {
  const values = input
    ? sameInstallationDeclaration(options, input)
      ? input.values
      : {}
    : (options.currentValues ?? {});
  return Object.fromEntries(
    options.fields.map((field) => [
      field.id,
      typeof values[field.id] === "string" ? values[field.id] : "",
    ]),
  );
}

/** null means incomplete; undefined means the declaration has no input fields. */
export function reviewedInstallationInput(
  options?: InstallationOptions,
  input?: InstallationInput,
): InstallationInput | null | undefined {
  if (!options) return input ? null : undefined;
  if (input && !sameInstallationDeclaration(options, input)) return null;
  const values = installationValues(options, input);
  if (
    options.fields.some(
      (field) =>
        field.valueKind !== "model" ||
        (field.required && !values[field.id]) ||
        (values[field.id] && !publicModelValue(values[field.id])),
    )
  )
    return null;
  return {
    declarationId: options.declarationId,
    registryVersion: options.registryVersion,
    launch: structuredClone(options.launch),
    values: Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== ""),
    ),
  };
}
