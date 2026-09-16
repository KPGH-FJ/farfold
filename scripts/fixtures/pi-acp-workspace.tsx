import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { PiWorkspace } from "../../src/components/PiWorkspace";
import {
  startHostShadow,
  type HostEventDelivery,
  type HostPendingInteraction,
  type HostSessionBinding,
} from "../../src/runtime/host-shadow";
import type { PiAcpStatus } from "../../src/runtime/pi-acp";
import type { PiNativeAuthSnapshot } from "../../src/runtime/pi-native-auth";
import type { ActiveHostTurn } from "../../src/runtime/host-turns";
import type { LifeModelWorkspace } from "../../src/runtime/use-lifemodel-workspace";
import "../../src/styles.css";

// Browser-only contract fixture. Every invoke is intercepted; no native I/O.
const calls: { command: string; args: unknown }[] = [];
let nativeAuthFlow: PiNativeAuthSnapshot | null = null;
let binding: HostSessionBinding = {
  farfoldSessionId: "fixture-host",
  nativeSessionId: "fixture-native",
  runtimeProductId: "pi",
  installationId: "bundled-pi-acp",
  adapterId: "pi-acp-stdio-v1",
  runtimeBuildId: "fixture-build",
  connectionId: "fixture-connection",
  projectId: "fixture-project",
  projectPath: "/fixture",
  projectName: "Fixture",
  workingCopyId: "fixture-wc",
  workingCopyPath: "/fixture",
  workingCopyKind: "root",
  branchName: null,
  nativeLocatorRegistered: true,
  title: "ACP Contract",
  titleSource: "native",
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  unreviewedChangeCount: 0,
};
const model = {
  api: "openai-completions",
  provider: "fixture-provider",
  id: "fixture-model",
  name: "Fixture Model",
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const nativeModel = {
  ...model,
  provider: "anthropic",
  id: "native-fixture-model",
  name: "Native Fixture Model",
};
let selectedModel = model;
let status: PiAcpStatus = {
  running: true,
  generation: 9,
  runtime: {
    productId: "pi",
    installationId: binding.installationId,
    adapterId: binding.adapterId,
  },
  runtimeBuildId: binding.runtimeBuildId,
  runtimeConnectionId: binding.connectionId,
  cwd: "/fixture",
  nativeSession: {
    version: 1,
    sessionId: binding.nativeSessionId,
    sessionFile: "/fixture/native.jsonl",
    cwd: "/fixture",
  },
  configOptions: [],
  managedProvider: {
    providerConnectionId: "fixture-provider",
    providerConfigVersionId: "v1",
    runtimeProviderId: model.provider,
    runtimeModelId: `${model.provider}/${model.id}`,
  },
  modelSource: null,
  nativeAdmissionReady: false,
  lastConfirmedModelSource: null,
  configurationState: "confirmed",
  lastError: null,
  droppedEvents: 0,
};
status.modelSource = {
  kind: "managed_version",
  binding: status.managedProvider!,
};
status.lastConfirmedModelSource = status.modelSource;
const liveStatus = structuredClone(status);
if (new URLSearchParams(location.search).has("idle-on-start"))
  status = { ...status, running: false, lastError: "FIXTURE IDLE EOF" };
const navigation = {
  sessionIndex: { schemaVersion: 10, sessions: [binding] },
  restoreState: {
    lastProjectId: binding.projectId,
    lastSessionId: binding.farfoldSessionId,
    updatedAt: 1,
  },
};
let activeTurn: ActiveHostTurn | null = null;
let pending: HostPendingInteraction[] = [];
let deliver: (event: HostEventDelivery) => void;
let sequence = 0;
let dialogSequence = 7;
const drafts: Record<string, string> = { "fixture-host": "RESTORED ACP DRAFT" };
let providerVersion = "v1";
let rejectProviderSave = false;
let rejectListAfterSave = false;
let rejectNextList = false;
let rejectNextCreate = false;
let delayFirstList = new URLSearchParams(location.search).has("delayed-list");
let releaseFirstList: (() => void) | null = null;
const managedConnection = () => ({
  providerConnectionId: new URLSearchParams(location.search).has("apply-mode")
    ? "fixture-provider-b"
    : "fixture-provider",
  currentConfigVersionId: providerVersion,
  providerKey: "fixture",
  label: "Fixture Provider",
  accountLabel: "default",
  endpoint: "http://127.0.0.1:1/v1",
  apiKind: "openai-chat-completions",
  modelId: model.id,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  reasoning: true,
  imageInput: false,
  supportsDeveloperRole: true,
  supportsReasoningEffort: false,
  credentialRevisionFingerprint: "fixture-revision",
  updatedAt: 1,
});
let thought = "off";
let resolveTurn: ((value: unknown) => void) | null = null;
let prompt = "";
const history: unknown[] = [
  {
    role: "user",
    timestamp: 1,
    content: [{ type: "text", text: "RESTORED ACP HISTORY" }],
  },
];
const projection = () => ({
  runtime: status.runtime!,
  runtimeBuildId: binding.runtimeBuildId,
  connectionId: binding.connectionId,
  runtimeGeneration: status.generation,
  latestSequence: sequence,
  activity: activeTurn ? ("working" as const) : ("idle" as const),
  confidence: "current" as const,
  reconciliationReason: null,
  unknownEventCount: 0,
  staleGenerationCount: 0,
});
function native(event: Record<string, unknown>, stale = false) {
  deliver({
    type: "event",
    pendingInteractions: pending,
    projection: projection(),
    event: {
      streamId: "fixture-stream",
      sequence: ++sequence,
      runtime: status.runtime!,
      runtimeBuildId: binding.runtimeBuildId,
      connectionId: stale ? "stale-connection" : binding.connectionId,
      runtimeGeneration: status.generation,
      kind: "acp",
      preservation: "native",
      receivedAtMs: Date.now(),
      nativeEnvelope: {
        generation: status.generation,
        kind: "acp",
        payload: {
          method: "_pi/event",
          params: { version: 1, sessionId: binding.nativeSessionId, event },
        },
      },
    },
  });
}
function publishDialogs() {
  deliver({
    type: "state",
    streamId: "fixture-stream",
    latestSequence: sequence,
    liveProjections: [projection()],
    pendingInteractions: pending,
  });
}
function finish(outcome = "accepted") {
  if (!resolveTurn) throw new Error("No fixture turn");
  if (outcome === "unknown") {
    activeTurn = { ...activeTurn!, outcomeUnknown: true };
    resolveTurn({
      outcome: "unknown",
      detail: "FIXTURE UNKNOWN: no automatic resend",
    });
  } else {
    const assistant = {
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: "FINAL ACP RESULT" }],
    };
    history.push(
      {
        role: "user",
        timestamp: Date.now() - 1,
        content: [{ type: "text", text: prompt }],
      },
      assistant,
    );
    native({ type: "message_end", message: assistant });
    native({ type: "agent_settled" });
    pending = [];
    publishDialogs();
    const turnId = activeTurn!.turnId;
    activeTurn = null;
    resolveTurn(
      outcome === "accepted"
        ? { outcome, submission: { turnId, acceptedAt: Date.now() } }
        : { outcome, detail: "FIXTURE CANCELLED" },
    );
  }
  resolveTurn = null;
}
function invokeFixture(command: string, args: unknown): unknown {
  calls.push({ command, args });
  const input = (args as { input?: Record<string, any> })?.input;
  if (command === "pi_acp_status") return structuredClone(status);
  if (command === "turn_coordinator_snapshot")
    return { activeTurns: activeTurn ? [structuredClone(activeTurn)] : [] };
  if (command === "host_navigation_snapshot") return navigation;
  if (command === "managed_provider_connection_list") {
    if (delayFirstList) {
      delayFirstList = false;
      const items = [managedConnection()];
      return new Promise((resolve) => {
        releaseFirstList = () => resolve(items);
      });
    }
    if (rejectNextList) {
      rejectNextList = false;
      throw new Error("FIXTURE LIST REFRESH REJECTED");
    }
    return [managedConnection()];
  }
  if (command === "managed_provider_api_key_save") {
    if (rejectProviderSave) throw new Error("FIXTURE SAVE REJECTED");
    providerVersion = "v2";
    rejectNextList = rejectListAfterSave;
    return {
      ...managedConnection(),
      projectionSnapshot: {
        connection: {
          ...managedConnection(),
          source: "farfold_managed",
          createdAt: 1,
        },
        projections: [],
      },
    };
  }
  if (command === "host_session_create") {
    if (rejectNextCreate) {
      rejectNextCreate = false;
      throw new Error("FIXTURE CREATE REJECTED");
    }
    if (
      status.runtime ||
      input?.connectionId !== "pi-acp-managed-local-v1" ||
      input?.options?.managedProvider?.providerConfigVersionId !==
        providerVersion
    )
      throw new Error(
        "fixture create did not use stopped connection and selected Provider version",
      );
    binding = {
      ...binding,
      farfoldSessionId: "fixture-host-new",
      nativeSessionId: "fixture-native-new",
      connectionId: `fixture-connection-${providerVersion}`,
      title: "NEW ACP SESSION",
    };
    navigation.sessionIndex.sessions.push(binding);
    navigation.restoreState.lastSessionId = binding.farfoldSessionId;
    history.splice(0);
    status = {
      ...structuredClone(liveStatus),
      generation: status.generation + 1,
      runtimeConnectionId: binding.connectionId,
      nativeSession: {
        ...liveStatus.nativeSession!,
        sessionId: binding.nativeSessionId,
      },
      managedProvider: {
        ...liveStatus.managedProvider!,
        providerConfigVersionId: providerVersion,
      },
    };
    status.modelSource = {
      kind: "managed_version",
      binding: status.managedProvider!,
    };
    status.lastConfirmedModelSource = status.modelSource;
    return {
      farfoldSessionId: binding.farfoldSessionId,
      runtimeProductId: "pi",
      installationId: binding.installationId,
      nativeSessionId: binding.nativeSessionId,
      runtimeGeneration: status.generation,
      runtimeReadyAt: Date.now(),
      openedAt: Date.now(),
      navigation,
    };
  }
  if (command === "host_session_open") {
    if (status.runtime || input?.farfoldSessionId !== binding.farfoldSessionId)
      throw new Error("fixture original connection not cleaned before open");
    status = {
      ...structuredClone(liveStatus),
      generation: status.generation + 1,
    };
    return {
      farfoldSessionId: binding.farfoldSessionId,
      runtimeProductId: "pi",
      installationId: binding.installationId,
      nativeSessionId: binding.nativeSessionId,
      runtimeGeneration: status.generation,
      runtimeReadyAt: Date.now(),
      openedAt: Date.now(),
      navigation,
    };
  }
  if (command === "session_draft_get")
    return {
      farfoldSessionId: (args as { farfoldSessionId: string }).farfoldSessionId,
      body:
        drafts[(args as { farfoldSessionId: string }).farfoldSessionId] ?? "",
      updatedAt: 1,
    };
  if (command === "session_draft_set") {
    drafts[input!.farfoldSessionId] = input!.body;
    return {
      farfoldSessionId: input!.farfoldSessionId,
      body: input!.body,
      updatedAt: 1,
    };
  }
  if (command === "session_draft_clear") {
    drafts[(args as { farfoldSessionId: string }).farfoldSessionId] = "";
    return null;
  }
  if (command === "runtime_project_readiness") return null;
  if (
    command === "host_session_metadata_update" ||
    command === "host_session_focus"
  )
    return navigation;
  if (command === "host_provider_projection_snapshot") {
    if (!new URLSearchParams(location.search).has("apply-mode"))
      throw new Error("Unknown Provider connection: fixture");
    const old = input?.providerConnectionId === "fixture-provider";
    const selected = old ? liveStatus.managedProvider! : status.managedProvider;
    return {
      connection: {
        providerConnectionId: old ? "fixture-provider" : "fixture-provider-b",
        providerKey: "fixture",
        label: old ? "Verified Provider A" : "Provider B",
        source: "farfold_managed",
        currentConfigVersionId: old ? "v1" : providerVersion,
        createdAt: 1,
        updatedAt: 1,
      },
      projections: selected
        ? [
            {
              ...selected,
              configVersionId: selected.providerConfigVersionId,
              runtimeProductId: "pi",
              installationId: binding.installationId,
              runtimeConnectionId: binding.connectionId,
              saveState: "saved",
              applyState: "applied",
              requestState: old ? "verified_success" : "not_requested",
              requestVerifiedVersionId: old ? "v1" : null,
              activeTaskPolicy: "current_task_keeps_bound_config",
              detail: null,
              updatedAt: 1,
            },
          ]
        : [],
    };
  }
  if (command === "pi_acp_workspace") {
    switch (input!.section) {
      case "auth_catalog":
        return {
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              credentialType:
                nativeAuthFlow?.state === "succeeded" &&
                nativeAuthFlow.operation === "login"
                  ? nativeAuthFlow.authType
                  : null,
              methods: [
                { type: "api_key", name: "原生 API key" },
                { type: "oauth", name: "原生 OAuth" },
              ],
            },
          ],
        };
      case "state":
        return {
          sessionId: binding.nativeSessionId,
          sessionFile: status.nativeSession!.sessionFile,
          model: selectedModel,
          isStreaming: activeTurn !== null,
          pendingMessageCount: 0,
          thinkingLevel: thought,
        };
      case "models":
        return {
          models:
            nativeAuthFlow?.state === "succeeded" &&
            nativeAuthFlow.operation === "login"
              ? [model, nativeModel]
              : [model],
        };
      case "thinking_levels":
        return { levels: ["off", "high"] };
      case "messages":
        return { messages: structuredClone(history) };
      case "commands":
        return { commands: [] };
      case "stats":
        return { contextUsage: { percent: 1 } };
    }
  }
  if (command === "pi_acp_native_auth") {
    if (
      input!.farfoldSessionId !== binding.farfoldSessionId ||
      input!.nativeSessionId !== binding.nativeSessionId ||
      input!.runtimeGeneration !== status.generation
    )
      throw new Error("stale auth target");
    const auth = input!.command as Record<string, string>;
    if (auth.action === "start") {
      nativeAuthFlow = {
        version: 1,
        sessionId: binding.nativeSessionId,
        flowId: "auth-fixture",
        providerId: auth.providerId,
        authType: auth.authType as "api_key" | "oauth",
        operation: auth.operation === "logout" ? "logout" : "login",
        state: "running",
        credentialState: "unknown",
        refreshState: "not_attempted",
        prompt: {
          id: "auth-prompt",
          value: { type: "secret", message: "原生密钥" },
        },
        notice: null,
      };
      status.configurationState = "changing";
      status.modelSource = null;
      status.managedProvider = null;
      if (auth.operation === "logout") {
        nativeAuthFlow.state = "succeeded";
        nativeAuthFlow.credentialState = "committed";
        nativeAuthFlow.refreshState = "confirmed";
        nativeAuthFlow.prompt = null;
        status.configurationState = "confirmed";
        status.modelSource = status.lastConfirmedModelSource;
        status.managedProvider =
          status.modelSource?.kind === "managed_version"
            ? status.modelSource.binding
            : null;
      }
    } else {
      if (!nativeAuthFlow || auth.flowId !== nativeAuthFlow.flowId)
        throw new Error("stale auth flow");
      if (auth.action === "reply") {
        if (
          auth.promptId !== nativeAuthFlow.prompt?.id ||
          auth.value !== "synthetic-auth-secret"
        )
          throw new Error("stale auth prompt");
        nativeAuthFlow.prompt = null;
        nativeAuthFlow.credentialState = "committed";
        const failed = new URLSearchParams(location.search).has("auth-failure");
        nativeAuthFlow.state = failed ? "unknown" : "succeeded";
        nativeAuthFlow.refreshState = failed ? "unknown" : "confirmed";
        status.configurationState = failed ? "unknown" : "confirmed";
        status.lastError = failed ? "FIXTURE AUTH REFRESH UNKNOWN" : null;
        status.modelSource = failed ? null : status.lastConfirmedModelSource;
        status.managedProvider =
          status.modelSource?.kind === "managed_version"
            ? status.modelSource.binding
            : null;
      } else if (auth.action === "cancel") {
        nativeAuthFlow.prompt = null;
        nativeAuthFlow.state = "unknown";
        status.configurationState = "unknown";
        status.lastError = "FIXTURE AUTH CANCEL UNKNOWN";
      }
    }
    return structuredClone(nativeAuthFlow);
  }
  if (command === "host_pi_acp_turn_submit") {
    if (activeTurn) throw new Error("duplicate fixture turn");
    prompt = input!.text;
    activeTurn = {
      turnId: `turn-${calls.length}`,
      farfoldSessionId: binding.farfoldSessionId,
      nativeSessionId: binding.nativeSessionId,
      runtimeGeneration: status.generation,
      workingCopyId: binding.workingCopyId,
      runtimeProductId: "pi",
      installationId: binding.installationId,
      runtimeConnectionId: binding.connectionId,
      startedAt: Date.now(),
      runtimeObserved: true,
      outcomeUnknown: false,
      abortRequested: false,
    };
    return new Promise((resolve) => {
      resolveTurn = resolve;
      native({ type: "agent_start" });
      native({
        type: "message_start",
        message: {
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "" }],
        },
      });
      native({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "LIVE ACP TEXT" },
      });
    });
  }
  if (command === "host_pi_acp_intervene") {
    if (input!.turnId !== activeTurn?.turnId)
      throw new Error("wrong fixture turn");
    return { outcome: "queued", delivery: input!.kind };
  }
  if (command === "host_pi_acp_turn_abort") {
    if (input!.turnId !== activeTurn?.turnId)
      throw new Error("wrong stop token");
    activeTurn!.abortRequested = true;
    finish("cancelled");
    return true;
  }
  if (command === "pi_acp_respond_dialog") {
    if (
      input!.requestId !== pending[0]?.piAcp?.requestKey ||
      input!.nativeRequestId !== pending[0]?.piAcp?.nativeRequestId
    )
      throw new Error("wrong fixture dialog identity");
    pending = [];
    publishDialogs();
    return null;
  }
  if (command === "pi_acp_set_config_option") {
    if (activeTurn) throw new Error("active configuration change");
    if (input!.configId === "thought_level") thought = input!.value;
    if (input!.configId === "model") {
      if (input!.value !== `${nativeModel.provider}/${nativeModel.id}`)
        throw new Error("unexpected native selection");
      selectedModel = nativeModel;
      status.managedProvider = null;
      status.modelSource = {
        kind: "native_observation",
        runtimeProviderId: nativeModel.provider,
        runtimeModelId: input!.value,
        nativeModelId: nativeModel.id,
      };
      status.lastConfirmedModelSource = status.modelSource;
      status.nativeAdmissionReady = true;
    }
    return structuredClone(status);
  }
  if (command === "pi_acp_apply_provider") {
    if (
      activeTurn ||
      input?.farfoldSessionId !== binding.farfoldSessionId ||
      input?.nativeSessionId !== binding.nativeSessionId ||
      input?.runtimeGeneration !== status.generation ||
      input?.provider?.providerConfigVersionId !== providerVersion
    )
      throw new Error("fixture apply identity mismatch");
    if (new URLSearchParams(location.search).has("apply-failure")) {
      status.lastError = "FIXTURE APPLY UNKNOWN";
      status.lastConfirmedModelSource = status.modelSource;
      status.modelSource = null;
      status.managedProvider = null;
      status.configurationState = "unknown";
      throw new Error(status.lastError);
    }
    model.provider = "farfold-managed-fixture-v2";
    status.managedProvider = {
      providerConnectionId: managedConnection().providerConnectionId,
      providerConfigVersionId: providerVersion,
      runtimeProviderId: model.provider,
      runtimeModelId: `${model.provider}/${model.id}`,
    };
    status.modelSource = {
      kind: "managed_version",
      binding: status.managedProvider,
    };
    status.lastConfirmedModelSource = status.modelSource;
    status.configurationState = "confirmed";
    return structuredClone(status);
  }
  if (command === "host_managed_runtime_stop") {
    activeTurn = null;
    status = {
      ...status,
      running: false,
      runtime: null,
      runtimeBuildId: null,
      runtimeConnectionId: null,
      nativeSession: null,
      managedProvider: null,
      modelSource: null,
      lastConfirmedModelSource: null,
      configurationState: "unknown",
      cwd: null,
    };
    return { runtimeProductId: "pi", status };
  }
  throw new Error(`Unexpected fixture command: ${command}`);
}
// Match IPC's value boundary so fixture mutation cannot bypass React updates.
mockIPC(async (command, args) =>
  structuredClone(await invokeFixture(command, args)),
);
const shadow = await startHostShadow(undefined, {
  initialSnapshot: async () => ({
    eventCursor: {
      streamId: "fixture-stream",
      latestSequence: 0,
      oldestAvailable: null,
      droppedTotal: 0,
    },
    storage: {},
    navigation: structuredClone(navigation),
    runtimes: [],
    liveProjections: [projection()],
    pendingInteractions: [],
  }),
  subscribe: async (_after, _limit, callback) => {
    deliver = callback;
    callback({
      type: "ready",
      snapshot: {
        streamId: "fixture-stream",
        requestedAfter: 0,
        oldestAvailable: null,
        latestSequence: 0,
        nextAfter: 0,
        hasMore: false,
        gap: null,
        events: [],
      },
    });
    return { subscriptionId: 1 };
  },
  eventSnapshot: async () => {
    throw new Error("unexpected fixture replay");
  },
  unsubscribe: async () => undefined,
});
const noop = () => undefined;
const lifeModel = new Proxy(
  {
    open: false,
    snapshot: null,
    candidates: [],
    selectedItemIds: [],
    unavailable: null,
    busy: false,
  },
  {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : noop,
  },
) as LifeModelWorkspace;
createRoot(document.getElementById("root")!).render(
  <PiWorkspace
    active
    initialProjectPath="/fixture"
    onProjectPath={noop}
    requestedHostSessionId={null}
    requestedHostSession={null}
    onRequestedHostSessionHandled={noop}
    onSelectRuntime={noop}
    onSelectHostSession={noop}
    themeMode="light"
    onThemeMode={noop}
    onOpenUpdate={noop}
    lifeModel={lifeModel}
    notice={null}
    hostChannel={{
      state: shadow.snapshot(),
      unavailable: false,
      reconnectForQa: async () => shadow.snapshot(),
    }}
  />,
);
Object.assign(window, {
  piFixture: {
    calls,
    native,
    finish,
    idleCrash() {
      if (activeTurn) throw new Error("idle crash requires no turn");
      status = { ...status, running: false, lastError: "FIXTURE IDLE EOF" };
    },
    getDraft: (sessionId = binding.farfoldSessionId) => drafts[sessionId] ?? "",
    rejectProviderSave(value: boolean) {
      rejectProviderSave = value;
    },
    rejectListAfterSave() {
      rejectListAfterSave = true;
    },
    rejectNextCreate() {
      rejectNextCreate = true;
    },
    releaseFirstList() {
      if (!releaseFirstList) throw new Error("No delayed list");
      releaseFirstList();
      releaseFirstList = null;
    },
    dialog(method = "confirm") {
      const id = dialogSequence++;
      pending = [
        {
          runtime: status.runtime!,
          runtimeGeneration: status.generation,
          interactionId: `rpc-${id}`,
          nativeSessionId: binding.nativeSessionId,
          kind: "pi_extension_dialog",
          state: "pending",
          piAcp: {
            requestKey: `rpc-${id}`,
            nativeRequestId: `native-ui-${id}`,
            nativeSessionId: binding.nativeSessionId,
            nativeEvent: {
              type: "extension_ui_request",
              id: `native-ui-${id}`,
              method,
              title: "FIXTURE DIALOG",
            },
          },
        },
      ];
      publishDialogs();
    },
  },
});
