import { invoke } from "@tauri-apps/api/core";
import type {
  CodexAcpConfigureSnapshot,
  CodexAcpScope,
} from "./codex-acp-contract";
import { sameCodexAcpScope } from "./codex-acp-workspace";

export type CodexConfigureStart = "browser" | "device" | "api_key" | "logout";
export type CodexConfigureCommand =
  | { action: "browser" | "device" | "logout" }
  | { action: "api_key"; key: string }
  | {
      action: "status" | "cancel";
      operationId: number;
      loginId: string | null;
    };

const phases = [
  "starting",
  "waiting",
  "confirming",
  "canceling",
  "confirmed",
  "canceled",
  "failed",
  "unknown",
];
const accounts = ["unconfirmed", "unauthenticated", "api_key", "chatgpt"];
const credentials = ["not_attempted", "committed", "removed", "unknown"];
const identity = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const terminal = (s: CodexAcpConfigureSnapshot | null) =>
  !!s && ["confirmed", "canceled", "failed"].includes(s.phase);
const invalid = () => new Error("Configure 回执无法核对");

function officialUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw invalid();
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["auth.openai.com", "chatgpt.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw invalid();
  return value;
}

// Validate and project a private receipt. Never put it in workspace/event/draft state.
export function checkedCodexConfigure(
  value: unknown,
  scope: CodexAcpScope,
  command: CodexConfigureCommand,
  previous: CodexAcpConfigureSnapshot | null,
  kind: CodexConfigureStart,
): CodexAcpConfigureSnapshot {
  const receipt = value as {
    kind?: string;
    snapshot?: CodexAcpConfigureSnapshot;
  } | null;
  const s = receipt?.snapshot;
  if (
    receipt?.kind !== "configure" ||
    !s?.scope ||
    !sameCodexAcpScope(s.scope, scope) ||
    !Number.isSafeInteger(s.operationId) ||
    s.operationId < 1 ||
    !phases.includes(s.phase) ||
    !accounts.includes(s.accountState) ||
    !credentials.includes(s.credentialState) ||
    (s.loginId !== null && !identity(s.loginId))
  )
    throw invalid();
  if (command.action === "status" || command.action === "cancel") {
    if (
      !previous ||
      s.operationId !== command.operationId ||
      previous.operationId !== command.operationId ||
      previous.loginId !== command.loginId ||
      (command.loginId !== null && s.loginId !== command.loginId)
    )
      throw invalid();
    if (
      (terminal(previous) && s.phase !== previous.phase) ||
      (previous.phase === "unknown" && s.phase !== "unknown") ||
      ((previous.phase === "canceling" || command.action === "cancel") &&
        s.phase === "waiting")
    )
      throw invalid();
  } else if (previous && s.operationId <= previous.operationId) throw invalid();
  if (
    (kind === "api_key" || kind === "logout") &&
    (s.loginId !== null || s.payload !== null)
  )
    throw invalid();
  if (s.payload !== null && s.phase !== "waiting") throw invalid();
  if (
    (kind === "browser" || kind === "device") &&
    ["waiting", "confirming", "confirmed"].includes(s.phase) &&
    !identity(s.loginId)
  )
    throw invalid();
  let payload: CodexAcpConfigureSnapshot["payload"] = null;
  if (s.phase === "waiting") {
    if (!identity(s.loginId)) throw invalid();
    if (kind === "browser" && s.payload?.type === "browser")
      payload = { type: "browser", authUrl: officialUrl(s.payload.authUrl) };
    else if (
      kind === "device" &&
      s.payload?.type === "device" &&
      typeof s.payload.userCode === "string" &&
      /^[A-Za-z0-9-]{1,128}$/.test(s.payload.userCode)
    )
      payload = {
        type: "device",
        verificationUrl: officialUrl(s.payload.verificationUrl),
        userCode: s.payload.userCode,
      };
    else throw invalid();
  }
  const samePastTerminal =
    previous?.operationId === s.operationId && terminal(previous);
  if (s.phase === "confirmed" && !samePastTerminal) {
    if (
      s.accountState !==
        (kind === "logout"
          ? "unauthenticated"
          : kind === "api_key"
            ? "api_key"
            : "chatgpt") ||
      s.credentialState !== (kind === "logout" ? "removed" : "committed")
    )
      throw invalid();
  }
  return {
    scope: { ...scope },
    operationId: s.operationId,
    phase: s.phase,
    loginId: s.loginId,
    credentialState: s.credentialState,
    accountState: s.accountState,
    payload,
  };
}

export function requestCodexAcpConfigure(
  scope: CodexAcpScope,
  command: CodexConfigureCommand,
): Promise<unknown> {
  return invoke("host_codex_acp_operation", {
    input: { action: "configure", scope, command },
  });
}

export function discoverCodexAcpConfigure(
  scope: CodexAcpScope,
): Promise<unknown> {
  return invoke("host_codex_acp_operation", {
    input: { action: "discover_configure", scope },
  });
}
interface DiscoveredOperation {
  kind: CodexConfigureStart;
  operationId: number;
  loginId: string | null;
  phase: CodexAcpConfigureSnapshot["phase"];
  inFlight: boolean;
}
export function checkedCodexConfigureDiscovery(
  value: unknown,
  scope: CodexAcpScope,
): DiscoveredOperation | null {
  const r = value as {
    kind?: string;
    discovery?: {
      scope?: CodexAcpScope;
      operation?: DiscoveredOperation | null;
    };
  } | null;
  if (
    r?.kind !== "configure_discovery" ||
    !r.discovery?.scope ||
    !sameCodexAcpScope(r.discovery.scope, scope)
  )
    throw invalid();
  const op = r.discovery.operation;
  if (op === null) return null;
  if (
    !op ||
    !["browser", "device", "api_key", "logout"].includes(op.kind) ||
    !Number.isSafeInteger(op.operationId) ||
    op.operationId < 1 ||
    !phases.includes(op.phase) ||
    typeof op.inFlight !== "boolean" ||
    (op.loginId !== null && !identity(op.loginId)) ||
    ((op.kind === "api_key" || op.kind === "logout") && op.loginId !== null) ||
    ((op.kind === "browser" || op.kind === "device") &&
      ["waiting", "confirming", "confirmed"].includes(op.phase) &&
      !identity(op.loginId))
  )
    throw invalid();
  return {
    kind: op.kind,
    operationId: op.operationId,
    loginId: op.loginId,
    phase: op.phase,
    inFlight: op.inFlight,
  };
}

export interface CodexConfigurePort {
  allowed: boolean;
  current: () => boolean;
  discover: (scope: CodexAcpScope) => Promise<unknown>;
  request: (
    scope: CodexAcpScope,
    command: CodexConfigureCommand,
  ) => Promise<unknown>;
}
export interface CodexConfigurePrivateState {
  checked: boolean;
  snapshot: CodexAcpConfigureSnapshot | null;
  busy: boolean;
  error: string | null;
}

/** View-lifetime owner only. Host/Runtime own operation state, IDs and cancellation. */
export class CodexConfigurePrivateView {
  private revision = 0;
  private active = true;
  private kind: CodexConfigureStart | null = null;
  private state: CodexConfigurePrivateState = {
    checked: false,
    snapshot: null,
    busy: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  constructor(
    private scope: CodexAcpScope,
    private port: () => CodexConfigurePort,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: CodexConfigurePrivateState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  activate() {
    this.active = true;
  }
  retire() {
    this.active = false;
    ++this.revision;
    this.kind = null;
    this.publish({ snapshot: null, busy: false, error: null, checked: false });
  }
  async discover() {
    const port = this.port();
    if (
      !this.active ||
      !port.allowed ||
      !port.current() ||
      this.state.busy ||
      this.state.error ||
      this.state.checked
    )
      return;
    const revision = ++this.revision;
    const current = () =>
      this.active &&
      revision === this.revision &&
      port.current() &&
      this.port().allowed;
    this.publish({ snapshot: null, busy: true, error: null, checked: false });
    try {
      const result = await port.discover(this.scope);
      if (!current()) return;
      const op = checkedCodexConfigureDiscovery(result, this.scope);
      if (!op) {
        this.kind = null;
        this.publish({
          snapshot: null,
          busy: false,
          error: null,
          checked: true,
        });
        return;
      }
      this.kind = op.kind;
      // A metadata observation is not an account receipt or permission to start again.
      const previous: CodexAcpConfigureSnapshot = {
        scope: { ...this.scope },
        operationId: op.operationId,
        loginId: op.loginId,
        phase: op.phase,
        accountState: "unconfirmed",
        credentialState: "unknown",
        payload: null,
      };
      if (op.inFlight || op.phase === "unknown") {
        this.publish({
          snapshot: previous,
          busy: false,
          error:
            op.phase === "unknown" ? "原配置结果未知；不会自动重试。" : null,
          checked: false,
        });
        return;
      }
      const command: CodexConfigureCommand = {
        action: "status",
        operationId: op.operationId,
        loginId: op.loginId,
      };
      const fresh = await port.request(this.scope, command);
      if (!current()) return;
      const snapshot = checkedCodexConfigure(
        fresh,
        this.scope,
        command,
        previous,
        op.kind,
      );
      this.publish({ snapshot, busy: false, error: null, checked: true });
    } catch {
      if (current())
        this.publish({
          snapshot: null,
          busy: false,
          error: "配置身份或结果未知；不会自动重试。",
          checked: false,
        });
    }
  }
  async request(
    action: CodexConfigureStart | "status" | "cancel",
    key?: string,
  ) {
    const port = this.port();
    if (
      !this.active ||
      !port.allowed ||
      !port.current() ||
      this.state.busy ||
      !this.state.checked
    )
      return;
    const previous = this.state.snapshot;
    let command: CodexConfigureCommand;
    if (action === "status" || action === "cancel") {
      if (
        !previous ||
        !this.kind ||
        (action === "cancel" &&
          (terminal(previous) || previous.phase === "unknown"))
      )
        return;
      command = {
        action,
        operationId: previous.operationId,
        loginId: previous.loginId,
      };
    } else {
      if (this.state.error || (previous && !terminal(previous))) return;
      if (
        action === "api_key" &&
        (!key?.trim() || key.length > 65536 || /[\r\n\0]/.test(key))
      )
        return;
      this.kind = action;
      command = action === "api_key" ? { action, key: key! } : { action };
    }
    const revision = ++this.revision;
    const current = () =>
      this.active &&
      revision === this.revision &&
      port.current() &&
      this.port().allowed;
    // A cancel attempt immediately withdraws instructions, without claiming cancellation.
    this.publish({
      checked: true,
      snapshot:
        action === "cancel" && previous
          ? { ...previous, payload: null }
          : previous,
      busy: true,
      error: null,
    });
    try {
      const pending = port.request(this.scope, command);
      key = undefined;
      // Do not retain key-bearing commands across the await; only their action is needed.
      if (command.action === "api_key")
        command = { action: "api_key", key: "" };
      const result = await pending;
      if (!current()) return;
      const snapshot = checkedCodexConfigure(
        result,
        this.scope,
        command,
        previous,
        this.kind!,
      );
      this.publish({ snapshot, busy: false, error: null, checked: true });
    } catch {
      if (!current()) return;
      this.publish({
        checked: true,
        snapshot: previous
          ? {
              ...previous,
              phase: "unknown",
              accountState: "unconfirmed",
              credentialState: "unknown",
              payload: null,
            }
          : null,
        busy: false,
        error: "配置结果未知；临时指令已撤销，不会自动重试。",
      });
    }
  }
}
