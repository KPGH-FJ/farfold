import type { AcpRuntimeClient, AcpSelectConfigOption } from "./acp-adapter";
import {
  OPENCODE_ACP_ADAPTER_ID,
  abortOpenCodeAcpTurn,
  openCodeAcpStatus,
  respondToOpenCodeAcpPermission,
  respondToOpenCodeAcpQuestion,
  setOpenCodeAcpConfigOption,
  submitOpenCodeAcpTurn,
  type OpenCodeAcpStatus,
} from "./opencode-acp";

// The OpenCode ACP client: protocol translation for the verified OpenCode ACP
// surface only. It owns no Agent loop and no session state; the panel keeps
// those.

export const openCodeAcpAdapter: AcpRuntimeClient<OpenCodeAcpStatus> = {
  adapterId: OPENCODE_ACP_ADAPTER_ID,
  status: openCodeAcpStatus,
  submitTurn: (input) =>
    submitOpenCodeAcpTurn(input) as Promise<
      Awaited<ReturnType<typeof submitOpenCodeAcpTurn>>
    >,
  abortTurn: abortOpenCodeAcpTurn,
  respondPermission: respondToOpenCodeAcpPermission,
  respondQuestion: respondToOpenCodeAcpQuestion,
  setConfigOption: setOpenCodeAcpConfigOption,
};

// OpenCode exposes model/mode selection as `select` configOptions. The primary
// model selector is the one the panel surfaces in the header; other selectors
// stay in the native config strip.
export function openCodeAcpPrimaryModelOption(
  options: AcpSelectConfigOption[],
): AcpSelectConfigOption | null {
  return (
    options.find((option) => option.category === "model") ??
    options.find(
      (option) =>
        option.category === "model_config" ||
        option.category === "thought_level",
    ) ??
    null
  );
}

export function safeProviderSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:@+-]/g, "_").slice(0, 96) || "default";
}

export function acpProviderConnectionId(option: AcpSelectConfigOption): string {
  return `opencode-acp-config-${safeProviderSegment(option.id)}`;
}

export function acpRuntimeProviderId(option: AcpSelectConfigOption): string {
  return `acp-config:${option.id}`;
}

export function acpRuntimeModelId(option: AcpSelectConfigOption): string {
  return `${option.id}:${option.currentValue}`;
}
