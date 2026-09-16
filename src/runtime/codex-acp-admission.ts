import { invoke } from "@tauri-apps/api/core";
import type { CodexAcpScope } from "./codex-acp-contract";
import {
  sameCodexAcpScope,
  type CodexAcpSelection,
  type CodexAcpWorkspaceSnapshot,
} from "./codex-acp-workspace";
export type CodexAdmissionSnapshot = Omit<
  NonNullable<CodexAcpWorkspaceSnapshot["admission"]>,
  "actual"
>;
export type CodexCatalogModel = NonNullable<
  CodexAdmissionSnapshot["catalog"]
>[number];
export type CodexAdmissionCommand =
  | { action: "refresh" }
  | {
      action: "select";
      observationScope: CodexAcpScope;
      epoch: number;
      catalogHash: string;
      selection: CodexAcpSelection;
    };
const invalid = () => new Error("目录或选择身份无法核对");
const identity = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 4096 && !v.includes("\0");
const sameSelection = (a: CodexAcpSelection | null, b: CodexAcpSelection) =>
  !!a &&
  a.catalogModelId === b.catalogModelId &&
  a.nativeModel === b.nativeModel &&
  a.provider === b.provider &&
  a.reasoningEffort === b.reasoningEffort;
function checkedChoice(
  s: CodexAdmissionSnapshot,
  c: CodexAcpSelection,
): CodexAcpSelection {
  if (
    !c ||
    ![c.catalogModelId, c.nativeModel, c.provider, c.reasoningEffort].every(
      identity,
    ) ||
    !s.account ||
    s.account.kind === "unauthenticated" ||
    !s.catalog?.some(
      (m) =>
        m.id === c.catalogModelId &&
        m.model === c.nativeModel &&
        !m.hidden &&
        m.inputModalities.includes("text") &&
        m.supportedReasoningEfforts.some(
          (e) => e.reasoningEffort === c.reasoningEffort,
        ),
    )
  )
    throw invalid();
  return {
    catalogModelId: c.catalogModelId,
    nativeModel: c.nativeModel,
    provider: c.provider,
    reasoningEffort: c.reasoningEffort,
  };
}
function checkedModel(m: CodexCatalogModel): CodexCatalogModel {
  if (
    !m ||
    !identity(m.id) ||
    !identity(m.model) ||
    !text(m.displayName) ||
    !text(m.description) ||
    typeof m.hidden !== "boolean" ||
    typeof m.isDefault !== "boolean" ||
    !identity(m.defaultReasoningEffort) ||
    !Array.isArray(m.supportedReasoningEfforts) ||
    m.supportedReasoningEfforts.length < 1 ||
    m.supportedReasoningEfforts.length > 32 ||
    !Array.isArray(m.inputModalities) ||
    m.inputModalities.length < 1 ||
    m.inputModalities.length > 2 ||
    !m.inputModalities.every((v) => ["text", "image"].includes(v)) ||
    new Set(m.inputModalities).size !== m.inputModalities.length
  )
    throw invalid();
  const efforts = m.supportedReasoningEfforts.map((e) => {
    if (!e || !identity(e.reasoningEffort) || !text(e.description))
      throw invalid();
    return { reasoningEffort: e.reasoningEffort, description: e.description };
  });
  if (
    new Set(efforts.map((e) => e.reasoningEffort)).size !== efforts.length ||
    !efforts.some((e) => e.reasoningEffort === m.defaultReasoningEffort)
  )
    throw invalid();
  return {
    id: m.id,
    model: m.model,
    displayName: m.displayName,
    description: m.description,
    hidden: m.hidden,
    isDefault: m.isDefault,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: m.defaultReasoningEffort,
    inputModalities: [...m.inputModalities],
  };
}
export function checkedCodexAdmission(
  value: unknown,
  scope: CodexAcpScope,
  command: CodexAdmissionCommand,
  previous: CodexAdmissionSnapshot | null,
): CodexAdmissionSnapshot {
  const r = value as {
    kind?: string;
    snapshot?: CodexAdmissionSnapshot;
  } | null;
  const s = r?.snapshot;
  if (
    r?.kind !== "admission" ||
    !s?.scope ||
    !sameCodexAcpScope(s.scope, scope) ||
    !Number.isSafeInteger(s.epoch) ||
    s.epoch < 1 ||
    !s.account ||
    !["apiKey", "chatgpt", "amazonBedrock", "unauthenticated"].includes(
      s.account.kind,
    ) ||
    typeof s.account.requiresOpenaiAuth !== "boolean" ||
    !Array.isArray(s.catalog) ||
    s.catalog.length > 512 ||
    typeof s.catalogHash !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(s.catalogHash) ||
    "actual" in s
  )
    throw invalid();
  const catalog = s.catalog.map(checkedModel);
  if (
    new Set(catalog.map((m) => m.id)).size !== catalog.length ||
    new TextEncoder().encode(JSON.stringify(catalog)).length > 262144
  )
    throw invalid();
  const checked: CodexAdmissionSnapshot = {
    scope: { ...scope },
    epoch: s.epoch,
    account: {
      kind: s.account.kind,
      requiresOpenaiAuth: s.account.requiresOpenaiAuth,
    },
    catalog,
    catalogHash: s.catalogHash,
    selection: null,
  };
  if (command.action === "refresh") {
    if (s.selection !== null) throw invalid();
    if (
      previous &&
      (!sameCodexAcpScope(previous.scope, scope) ||
        s.epoch < previous.epoch ||
        (s.epoch === previous.epoch &&
          (s.catalogHash !== previous.catalogHash ||
            JSON.stringify(catalog) !== JSON.stringify(previous.catalog) ||
            JSON.stringify(checked.account) !==
              JSON.stringify(previous.account))))
    )
      throw invalid();
  } else {
    if (
      !previous ||
      !sameCodexAcpScope(command.observationScope, scope) ||
      !sameCodexAcpScope(previous.scope, scope) ||
      command.epoch !== previous.epoch ||
      command.catalogHash !== previous.catalogHash ||
      s.epoch !== command.epoch ||
      s.catalogHash !== command.catalogHash ||
      JSON.stringify(catalog) !== JSON.stringify(previous.catalog) ||
      JSON.stringify(checked.account) !== JSON.stringify(previous.account) ||
      !sameSelection(s.selection, command.selection)
    )
      throw invalid();
    checkedChoice(previous, command.selection);
    checked.selection = checkedChoice(checked, command.selection);
  }
  return checked;
}
export function requestCodexAcpAdmission(
  scope: CodexAcpScope,
  command: CodexAdmissionCommand,
): Promise<unknown> {
  return invoke("host_codex_acp_operation", {
    input: { action: "admission", scope, command },
  });
}
export interface CodexAdmissionPort {
  allowed: boolean;
  bound: boolean;
  current: () => boolean;
  request: (
    scope: CodexAcpScope,
    command: CodexAdmissionCommand,
  ) => Promise<unknown>;
}
interface PrivateState {
  snapshot: CodexAdmissionSnapshot | null;
  busy: boolean;
  error: string | null;
}
/** Ephemeral view lifetime only. Runtime/Host own admission, occupancy and Session choice. */
export class CodexAdmissionPrivateView {
  private revision = 0;
  private active = true;
  private state: PrivateState = { snapshot: null, busy: false, error: null };
  private listeners = new Set<() => void>();
  constructor(
    private scope: CodexAcpScope,
    private port: () => CodexAdmissionPort,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  private publish(s: PrivateState) {
    this.state = s;
    this.listeners.forEach((f) => f());
  }
  activate() {
    this.active = true;
  }
  retire() {
    this.active = false;
    ++this.revision;
    this.publish({ snapshot: null, busy: false, error: null });
  }
  edit() {
    if (this.state.snapshot && !this.state.busy)
      this.publish({
        ...this.state,
        snapshot: { ...this.state.snapshot, selection: null },
      });
  }
  refresh() {
    return this.run({ action: "refresh" }, this.state.snapshot);
  }
  async select(selection: CodexAcpSelection) {
    const previous = this.state.snapshot;
    if (!previous || this.port().bound || this.state.busy) return;
    try {
      checkedChoice(previous, selection);
    } catch {
      return;
    }
    await this.run(
      {
        action: "select",
        observationScope: { ...this.scope },
        epoch: previous.epoch,
        catalogHash: previous.catalogHash!,
        selection: { ...selection },
      },
      previous,
    );
  }
  private async run(
    command: CodexAdmissionCommand,
    previous: CodexAdmissionSnapshot | null,
  ) {
    const port = this.port();
    if (!this.active || !port.allowed || !port.current() || this.state.busy)
      return;
    const revision = ++this.revision;
    const current = () =>
      this.active &&
      revision === this.revision &&
      port.current() &&
      this.port().allowed;
    this.publish({ snapshot: null, busy: true, error: null });
    try {
      const response = await port.request(this.scope, command);
      if (!current()) return;
      const snapshot = checkedCodexAdmission(
        response,
        this.scope,
        command,
        previous,
      );
      this.publish({ snapshot, busy: false, error: null });
    } catch {
      if (current())
        this.publish({
          snapshot: null,
          busy: false,
          error: "目录或选择结果未确认；当前可用性已清空，不会自动重试。",
        });
    }
  }
}
