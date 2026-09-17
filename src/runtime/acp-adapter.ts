// Frontend counterpart of the Host-side AcpRuntimeAdapter boundary: a Runtime
// panel talks to one AcpRuntimeClient implementation, never to raw invoke
// calls. Responses stay `unknown`/native envelopes where the verified ACP
// surface differs between Runtimes.

/** A `type: "select"` ACP configOption, such as a model or mode selector. */
export interface AcpSelectConfigOption {
  id: string;
  name: string;
  category: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function acpSelectConfigOptions(
  value: unknown,
): AcpSelectConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = record(item);
    if (!option || option.type !== "select") return [];
    const id = stringValue(option.id);
    const name = stringValue(option.name);
    const currentValue = stringValue(option.currentValue);
    const values = Array.isArray(option.options)
      ? option.options.flatMap((entry) => {
          const value = record(entry);
          const rawValue = stringValue(value?.value);
          const rawName = stringValue(value?.name);
          return rawValue && rawName
            ? [
                {
                  value: rawValue,
                  name: rawName,
                  description: stringValue(value?.description) || undefined,
                },
              ]
            : [];
        })
      : [];
    if (!id || !name || !currentValue || values.length === 0) return [];
    return [
      {
        id,
        name,
        category: stringValue(option.category),
        currentValue,
        options: values,
      },
    ];
  });
}

export interface AcpSessionTarget {
  farfoldSessionId: string;
  nativeSessionId: string;
}

export interface AcpTurnSubmit extends AcpSessionTarget {
  providerConnectionId?: string;
  providerConfigVersionId?: string;
  runtimeProviderId?: string;
  runtimeModelId?: string;
  text: string;
}

export type AcpTurnOutcome =
  | { outcome: "accepted"; submission: unknown }
  | { outcome: "cancelled"; detail: string }
  | { outcome: "failed"; detail: string }
  | { outcome: "unknown"; detail: string };

export interface AcpPermissionResponse extends AcpSessionTarget {
  runtimeGeneration: number;
  requestId: string;
  optionId: string;
}

export interface AcpQuestionResponse extends AcpSessionTarget {
  runtimeGeneration: number;
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | string[]>;
}

export interface AcpConfigOptionUpdate extends AcpSessionTarget {
  configId: string;
  value: string | boolean;
  valueType?: "boolean";
}

export interface AcpRuntimeClient<TStatus> {
  readonly adapterId: string;
  status(): Promise<TStatus>;
  submitTurn(input: AcpTurnSubmit): Promise<AcpTurnOutcome>;
  abortTurn(target: AcpSessionTarget): Promise<boolean>;
  respondPermission(input: AcpPermissionResponse): Promise<unknown>;
  respondQuestion(input: AcpQuestionResponse): Promise<unknown>;
  setConfigOption(input: AcpConfigOptionUpdate): Promise<TStatus>;
}
