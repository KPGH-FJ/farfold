import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { CodexConnectionPanel } from "../../src/components/CodexConnectionPanel";
import { CodexAcpModelPanel } from "../../src/components/CodexAcpModelPanel";
import type {
  CodexAdmissionCommand,
  CodexAdmissionSnapshot,
} from "../../src/runtime/codex-acp-admission";
import { codexWorkspaceBackend } from "../../src/runtime/codex-workspace-backend";
import type {
  CodexAcpScope,
  CodexAcpConfigureSnapshot,
} from "../../src/runtime/codex-acp-contract";
import type {
  CodexConfigureCommand,
  CodexConfigureStart,
} from "../../src/runtime/codex-acp-configure";
import type { HostSessionBinding } from "../../src/runtime/host-shadow";
import "../../src/styles.css";

// Browser-only fixture, never imported by the application. Every IPC is intercepted.
const audit: { action: string; generation: number; operationId?: number }[] =
  [];
const snapshots = new Map<number, CodexAcpConfigureSnapshot>();
const kinds = new Map<number, CodexConfigureStart>();
const inFlight = new Set<number>();
const admission = new Map<number, CodexAdmissionSnapshot>();
let modelBound = false;
const syntheticModel = {
  id: "picker",
  model: "native-model",
  displayName: "SYNTHETIC VISIBLE",
  description: "",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "" },
    { reasoningEffort: "high", description: "" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
};
let operation = 0;
let delay = false;
let fail = false;
let release: (() => void) | null = null;
mockIPC(async (name, args = {}) => {
  if (name !== "host_codex_acp_operation")
    throw new Error("Unexpected mock IPC");
  const modelInput = args.input as {
    action: string;
    scope: CodexAcpScope;
    command: CodexAdmissionCommand;
  };
  if (modelInput.action === "admission") {
    const { scope, command } = modelInput;
    audit.push({
      action: `admission_${command.action}`,
      generation: scope.generation,
    });
    document.getElementById("audit")!.textContent = JSON.stringify(
      audit,
      null,
      2,
    );
    if (fail) {
      fail = false;
      throw new Error("PRIVATE-ADMISSION-ERROR");
    }
    const auth = snapshots.get(scope.generation);
    if (
      inFlight.has(scope.generation) ||
      (auth && !["confirmed", "canceled", "failed"].includes(auth.phase))
    )
      throw new Error("Synthetic Configure occupied or unknown");
    let s = admission.get(scope.generation) ?? {
      scope,
      epoch: 1,
      account: { kind: "apiKey", requiresOpenaiAuth: true },
      catalog: [
        syntheticModel,
        {
          ...syntheticModel,
          id: "hidden",
          displayName: "HIDDEN MODEL",
          hidden: true,
        },
      ],
      catalogHash: "a".repeat(64),
      selection: null,
    };
    if (command.action === "select") {
      if (
        modelBound ||
        command.epoch !== s.epoch ||
        command.catalogHash !== s.catalogHash ||
        JSON.stringify(command.observationScope) !== JSON.stringify(scope) ||
        command.selection.catalogModelId !== syntheticModel.id ||
        command.selection.nativeModel !== syntheticModel.model ||
        !syntheticModel.supportedReasoningEfforts.some(
          (e) => e.reasoningEffort === command.selection.reasoningEffort,
        ) ||
        !command.selection.provider
      )
        throw new Error("Synthetic selection rejected");
      s = { ...s, selection: { ...command.selection } };
    } else s = { ...s, selection: null };
    admission.set(scope.generation, s);
    const response = { kind: "admission", snapshot: s };
    if (delay) {
      delay = false;
      inFlight.add(scope.generation);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      inFlight.delete(scope.generation);
    }
    return response;
  }
  const input = args.input as {
    action: string;
    scope: CodexAcpScope;
    command: CodexConfigureCommand;
  };
  if (!["configure", "discover_configure"].includes(input.action))
    throw new Error("Unexpected mock action");
  const { scope, command } = input;
  audit.push({
    action: input.action === "configure" ? command.action : input.action,
    generation: scope.generation,
    operationId:
      command && "operationId" in command ? command.operationId : undefined,
  });
  document.getElementById("audit")!.textContent = JSON.stringify(
    audit,
    null,
    2,
  ); // No args, keys, URLs or codes.
  if (fail) {
    fail = false;
    throw new Error("SYNTHETIC-SECRET-ERROR-MUST-NOT-SHOW");
  }
  let s = snapshots.get(scope.generation);
  if (input.action === "discover_configure") {
    const response = {
      kind: "configure_discovery",
      discovery: {
        scope,
        operation: s
          ? {
              kind: kinds.get(scope.generation),
              operationId: s.operationId,
              loginId: s.loginId,
              phase: s.phase,
              inFlight: inFlight.has(scope.generation),
            }
          : null,
      },
    };
    if (delay) {
      delay = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return response;
  }
  if (inFlight.has(scope.generation))
    throw new Error("Synthetic Host request occupied");
  if (command.action === "status" || command.action === "cancel") {
    if (
      !s ||
      command.operationId !== s.operationId ||
      command.loginId !== s.loginId
    )
      throw new Error("Wrong synthetic operation identity");
    if (command.action === "cancel")
      s = {
        ...s,
        phase: "canceled",
        payload: null,
        credentialState: "unknown",
        accountState: "unconfirmed",
      };
  } else {
    if (s && !["confirmed", "canceled", "failed"].includes(s.phase))
      throw new Error("Synthetic Host operation occupied");
    kinds.set(scope.generation, command.action);
    const key = command.action === "api_key";
    const logout = command.action === "logout";
    s = {
      scope,
      operationId: ++operation,
      loginId: key || logout ? null : `synthetic-login-${operation}`,
      phase: key || logout ? "confirmed" : "waiting",
      credentialState: logout ? "removed" : key ? "committed" : "not_attempted",
      accountState: logout
        ? "unauthenticated"
        : key
          ? "api_key"
          : "unconfirmed",
      payload:
        command.action === "browser"
          ? {
              type: "browser",
              authUrl: "https://auth.openai.com/SYNTHETIC-URL",
            }
          : command.action === "device"
            ? {
                type: "device",
                verificationUrl: "https://auth.openai.com/SYNTHETIC-DEVICE",
                userCode: "SYNTHETIC-CODE",
              }
            : null,
    };
  }
  snapshots.set(scope.generation, s);
  const response = { kind: "configure", snapshot: s };
  if (delay) {
    delay = false;
    inFlight.add(scope.generation);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    inFlight.delete(scope.generation);
  }
  return response;
});
const binding: HostSessionBinding = {
  farfoldSessionId: "synthetic-session",
  runtimeProductId: "codex",
  installationId: "synthetic-installation",
  runtimeBuildId: "synthetic-build",
  adapterId: "codex-acp-stdio-v1",
  connectionId: "synthetic-connection",
  nativeSessionId: "synthetic-thread",
  projectId: "project",
  projectPath: "/fixture",
  projectName: "Fixture",
  workingCopyId: "worktree",
  workingCopyPath: "/fixture",
  workingCopyKind: "root",
  branchName: null,
  nativeLocatorRegistered: true,
  title: "Fixture",
  titleSource: "manual",
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  unreviewedChangeCount: 0,
};
function Fixture() {
  const [generation, setGeneration] = useState(1);
  const [visible, setVisible] = useState(true);
  const [visit, setVisit] = useState(0);
  const [configureRevision, setConfigureRevision] = useState(0);
  const [bound, setBound] = useState(false);
  const scope: CodexAcpScope = {
    runtimeProductId: "codex",
    installationId: binding.installationId,
    runtimeBuildId: binding.runtimeBuildId,
    adapterId: "codex-acp-stdio-v1",
    adapterBuildId: "synthetic-adapter",
    connectionId: binding.connectionId,
    profileId: "synthetic-profile",
    generation,
  };
  const backend = codexWorkspaceBackend(binding, () => true, undefined, scope);
  return (
    <main style={{ maxWidth: 760, margin: "20px auto", padding: 20 }}>
      <h1>Configure 无网络组件合同</h1>
      <p>只有 mock-IPC；无原生启动、模型、真实登录或浏览器跳转。</p>
      <section aria-label="测试控制">
        <button
          onClick={() => {
            setVisible(!visible);
            setVisit((v) => v + 1);
          }}
        >
          切换视图
        </button>
        <button onClick={() => setGeneration((v) => v + 1)}>
          切换连接代次
        </button>
        <button
          onClick={() => {
            delay = true;
          }}
        >
          挂起下一回执
        </button>
        <button
          onClick={() => {
            release?.();
            release = null;
          }}
        >
          释放旧回执
        </button>
        <button
          onClick={() => {
            fail = true;
          }}
        >
          下一请求失败
        </button>
        <p>合成连接代次：{generation}</p>
        <button
          onClick={() => {
            const s = admission.get(generation);
            if (s)
              admission.set(generation, {
                ...s,
                epoch: s.epoch + 1,
                catalogHash: (s.catalogHash?.startsWith("a")
                  ? "b"
                  : "a"
                ).repeat(64),
                selection: null,
              });
          }}
        >
          使目录过期
        </button>
        <button
          onClick={() => {
            modelBound = !bound;
            setBound(!bound);
          }}
        >
          切换 Session 绑定
        </button>
        <button
          onClick={() => {
            const s = snapshots.get(generation);
            if (s)
              snapshots.set(generation, {
                ...s,
                phase: "confirmed",
                payload: null,
                accountState:
                  kinds.get(generation) === "api_key" ? "api_key" : "chatgpt",
                credentialState: "committed",
              });
          }}
        >
          后台完成原认证
        </button>
      </section>
      {visible && (
        <div aria-label="合成可操作面板">
          <CodexConnectionPanel
            acp={{
              scope,
              viewKey: `fixture-${visit}`,
              port: {
                allowed: true,
                current: () => true,
                request: (scope, command) => {
                  setConfigureRevision((v) => v + 1);
                  return backend.configureAcp(scope, command);
                },
                discover: backend.discoverConfigureAcp,
              },
            }}
          />
          <CodexAcpModelPanel
            scope={scope}
            viewKey={JSON.stringify([visit, configureRevision])}
            port={{
              allowed: true,
              bound,
              current: () => true,
              request: backend.admissionAcp,
            }}
          />
        </div>
      )}
      <div aria-label="生产关闭面板">
        <CodexAcpModelPanel
          scope={scope}
          viewKey="production"
          port={{
            allowed: backend.capabilities.selectModel,
            bound: true,
            current: backend.current,
            request: backend.admissionAcp,
          }}
        />
        <CodexConnectionPanel
          acp={{
            scope,
            viewKey: "production",
            port: {
              allowed: backend.capabilities.configure,
              current: backend.current,
              request: backend.configureAcp,
              discover: backend.discoverConfigureAcp,
            },
          }}
        />
      </div>
      <p>生产能力：{JSON.stringify(backend.capabilities)}</p>
      <details>
        <summary>仅操作名与合成身份审计</summary>
        <pre id="audit" />
      </details>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
