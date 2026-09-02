import { invoke } from "@tauri-apps/api/core";
import type {
  RuntimeAdapter,
  RuntimeConnectionReadiness,
  RuntimeDescriptor,
  RuntimeIdentity,
  RuntimeSessionBinding,
} from "./adapter";

export const PI_RUNTIME_IDENTITY: RuntimeIdentity = Object.freeze({
  productId: "pi",
  installationId: "bundled-pi",
  adapterId: "pi-rpc-jsonl",
});

export const PI_LOCAL_CONNECTION_ID = "pi-local-native-config-v1";

export type RuntimePhase = "stopped" | "starting" | "running" | "stopping";

export interface RuntimeStatus {
  state: RuntimePhase;
  running: boolean;
  projectPath: string | null;
  sessionDir: string | null;
  generation: number;
  savedProjectPath: string | null;
  savedSessionFile: string | null;
}

export type ProjectTrust = "saved" | "approve" | "ignore";

export interface StartOptions {
  projectPath: string | null;
  sessionFile?: string | null;
  resumePrevious: boolean;
  projectTrust: ProjectTrust;
}

export interface SessionSummary {
  sessionFile: string;
  sessionId: string;
  projectPath: string;
  title: string;
  updatedAt: number;
  binding: RuntimeSessionBinding;
}

type NativeSessionSummary = Omit<SessionSummary, "binding">;

export function resumableSessionFile(
  sessionFile: string | null,
  sessions: Pick<SessionSummary, "sessionFile">[],
): string | null {
  const candidate = sessionFile?.trim();
  return candidate &&
    sessions.some((session) => session.sessionFile === candidate)
    ? candidate
    : null;
}

export interface ProjectResource {
  kind:
    | "settings"
    | "skill"
    | "extension"
    | "prompt"
    | "theme"
    | "system"
    | "append-system"
    | "agent-skill";
  entries: number;
  sources: string[];
}

export interface ProjectReadiness {
  projectPath: string;
  contextFiles: string[];
  protectedResources: ProjectResource[];
}

type RequestCommand = { id?: string } & (
  | { type: "prompt"; message: string }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort" }
  | { type: "new_session" }
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "get_entries"; since?: string }
  | { type: "get_available_models" }
  | { type: "get_available_thinking_levels" }
  | { type: "get_commands" }
  | { type: "get_session_stats" }
  | { type: "set_session_name"; name: string }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "switch_session"; sessionPath: string }
);

export type PiCommand =
  | RequestCommand
  | {
      type: "extension_ui_response";
      id: string;
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
    };

export type ExtensionDialogRequest = {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
};

export type ExtensionUiRequest =
  | ExtensionDialogRequest
  | {
      type: "extension_ui_request";
      id: string;
      method:
        "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
      message?: string;
      notifyType?: "info" | "warning" | "error";
      statusKey?: string;
      statusText?: string;
      widgetKey?: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
      title?: string;
      text?: string;
    };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseExtensionUiRequest(
  value: unknown,
): ExtensionUiRequest | null {
  const request = objectValue(value);
  if (
    request?.type !== "extension_ui_request" ||
    typeof request.id !== "string" ||
    typeof request.method !== "string"
  ) {
    return null;
  }
  const methods = [
    "select",
    "confirm",
    "input",
    "editor",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
  ] as const;
  if (!methods.includes(request.method as (typeof methods)[number]))
    return null;
  if (
    request.method === "select" ||
    request.method === "confirm" ||
    request.method === "input" ||
    request.method === "editor"
  ) {
    if (typeof request.title !== "string") return null;
    if (
      request.method === "select" &&
      (!Array.isArray(request.options) ||
        !request.options.every((option) => typeof option === "string"))
    ) {
      return null;
    }
  }
  return request as ExtensionUiRequest;
}

export interface LifecyclePayload {
  state: string;
  reason?: "stopped" | "exited" | "error";
  success?: boolean;
  code?: number | null;
  detail?: unknown;
}

type NativePiEnvelope = { generation: number } & (
  | { kind: "rpc"; payload: unknown }
  | { kind: "stderr"; payload: string }
  | { kind: "lifecycle"; payload: LifecyclePayload }
  | { kind: "protocol_error"; payload: { line: string; error: string } }
);

export type PiEnvelope = NativePiEnvelope & { runtime: RuntimeIdentity };

export type PiRpcResponse = Record<string, unknown> & {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
};

export function acceptsRuntimeEvent(
  currentGeneration: number,
  event: Pick<PiEnvelope, "generation">,
): boolean {
  return event.generation >= currentGeneration;
}

export function isRuntimeCommandReady(
  status: Pick<RuntimeStatus, "running" | "generation">,
  observedStateGeneration: number | null,
): boolean {
  return status.running && observedStateGeneration === status.generation;
}

export function lifecycleFailureMessage(
  payload: LifecyclePayload,
): string | null {
  if (payload.state !== "terminated" || payload.reason === "stopped") {
    return null;
  }
  if (payload.reason === "error") {
    return typeof payload.detail === "string"
      ? `Pi 进程状态检查失败：${payload.detail}`
      : "Pi 进程状态检查失败。";
  }
  if (payload.reason === "exited") {
    return payload.success
      ? "Pi sidecar 已意外退出。"
      : `Pi sidecar 异常退出${typeof payload.code === "number" ? `（code ${payload.code}）` : ""}。`;
  }
  return "Pi sidecar 已退出。请检查启动诊断后重试。";
}

export function runtimeStatus(): Promise<RuntimeStatus> {
  return invoke("runtime_status");
}

export function listSessions(): Promise<SessionSummary[]> {
  return invoke<NativeSessionSummary[]>("runtime_list_sessions").then(
    (sessions) =>
      sessions.map((session) => ({
        ...session,
        binding: Object.freeze({
          runtime: PI_RUNTIME_IDENTITY,
          connectionId: PI_LOCAL_CONNECTION_ID,
          projectPath: session.projectPath,
          nativeSessionId: session.sessionId,
        }),
      })),
  );
}

export function getProjectReadiness(
  projectPath: string,
): Promise<ProjectReadiness> {
  return invoke("runtime_project_readiness", { projectPath });
}

export function startRuntime(options: StartOptions): Promise<RuntimeStatus> {
  return invoke("runtime_start", {
    options: {
      ...options,
      sessionFile: options.sessionFile?.trim() || null,
    },
  });
}

export function stopRuntime(): Promise<RuntimeStatus> {
  return invoke("runtime_stop");
}

let requestSequence = 0;
const pendingRpc = new Map<
  string,
  {
    command: string;
    resolve: (response: PiRpcResponse) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function requestId(): string {
  requestSequence += 1;
  return `farfold-${Date.now()}-${requestSequence}`;
}

export function sendRpc(command: PiCommand): Promise<PiRpcResponse | void> {
  if (command.type === "extension_ui_response") {
    return invoke("runtime_send", { command });
  }

  const outgoing = command.id ? command : { ...command, id: requestId() };
  const id = outgoing.id;
  if (!id) return Promise.reject(new Error("Pi RPC request is missing an id"));

  return new Promise<PiRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error(`Pi RPC 请求超时：${command.type}`));
    }, 30_000);
    pendingRpc.set(id, { command: command.type, resolve, reject, timer });
    void invoke("runtime_send", { command: outgoing }).catch((reason) => {
      const pending = pendingRpc.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRpc.delete(id);
      pending.reject(
        reason instanceof Error ? reason : new Error(String(reason)),
      );
    });
  });
}

export function settleRpcResponse(value: unknown): boolean {
  const response = objectValue(value);
  if (
    response?.type !== "response" ||
    typeof response.id !== "string" ||
    typeof response.success !== "boolean"
  ) {
    return false;
  }
  const pending = pendingRpc.get(response.id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRpc.delete(response.id);
  if (response.success) {
    pending.resolve(response as PiRpcResponse);
  } else {
    pending.reject(
      new Error(
        typeof response.error === "string"
          ? response.error
          : `Pi 拒绝了 RPC 请求：${pending.command}`,
      ),
    );
  }
  return true;
}

export function rejectPendingRpc(reason: string): void {
  for (const [id, pending] of pendingRpc) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingRpc.delete(id);
  }
}

export function rememberSession(sessionFile: string): Promise<boolean> {
  return invoke("runtime_remember_session", { sessionFile });
}

export function pollPiEvents(): Promise<PiEnvelope[]> {
  return invoke<NativePiEnvelope[]>("runtime_poll_events").then((events) =>
    events.map((event) => ({ ...event, runtime: PI_RUNTIME_IDENTITY })),
  );
}

export function discoverRuntime(): Promise<RuntimeDescriptor> {
  return invoke("runtime_discover");
}

export async function runtimeConnectionReadiness(): Promise<
  RuntimeConnectionReadiness<RuntimePhase>
> {
  const current = await runtimeStatus();
  return {
    runtime: PI_RUNTIME_IDENTITY,
    phase: current.state,
    commandChannel: current.running ? "ready" : "not_ready",
    provider: "unknown",
    model: "unknown",
    account: "unknown",
    nativeConfiguration: "runtime_owned",
  };
}

export function cancelPiTurn(): Promise<PiRpcResponse | void> {
  return sendRpc({ type: "abort" });
}

export const piRuntimeAdapter: RuntimeAdapter<
  RuntimeStatus,
  RuntimePhase,
  StartOptions,
  SessionSummary,
  PiCommand,
  PiEnvelope,
  PiRpcResponse,
  ProjectReadiness
> = Object.freeze({
  identity: PI_RUNTIME_IDENTITY,
  discover: discoverRuntime,
  connectionReadiness: runtimeConnectionReadiness,
  status: runtimeStatus,
  start: startRuntime,
  stop: stopRuntime,
  send: sendRpc,
  cancelTurn: cancelPiTurn,
  settleResponse: settleRpcResponse,
  rejectPending: rejectPendingRpc,
  listSessions,
  rememberSession,
  projectReadiness: getProjectReadiness,
  pollEvents: pollPiEvents,
});
