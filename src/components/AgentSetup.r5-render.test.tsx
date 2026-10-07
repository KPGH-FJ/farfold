import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import type { AuthActivitySnapshot } from "../runtime/auth_activity";
import type {
  AgentCardModel,
  AgentsState,
  AuthMethodInfo,
} from "../runtime/agents";
import type { Credential, ServiceCapability } from "../runtime/credentials";
import type { PreparationInfo } from "../runtime/preparation";
import type { PreparationSnapshot } from "../runtime/agent_preparation";
import type { ThreadState } from "../runtime/session_types";
import type { AgentSetupProgress } from "./AgentSetup";
import type { Installation } from "./ProgramManager";

interface Scenario {
  id: string;
  label: string;
  reference: string;
  card: AgentCardModel;
  progress: AgentSetupProgress;
  methods: AuthMethodInfo[];
  preparation: PreparationInfo;
  capability: ServiceCapability;
  services: Credential[];
  installations: Installation[];
  job: AuthActivitySnapshot | null;
  snapshot: PreparationSnapshot;
  thread: ThreadState | null;
  intent?: "use" | "manage";
  editService?: boolean;
}

const h = vi.hoisted(() => ({
  current: null as Scenario | null,
  slots: new Map<string, unknown>(),
  effects: new Map<string, { deps?: unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[],
  changeService: null as (() => void) | null,
  reads: [] as string[],
  io: vi.fn(() => {
    throw new Error("Controlled render rejects external IO");
  }),
  execution: vi.fn(async () => {}),
  fixtureModelRead: vi.fn(async () => {}),
}));
function current() {
  if (!h.current) throw new Error("Missing controlled fixture");
  return h.current;
}

// All hook state and effect scheduling belongs to this test file. Production
// components, selectors and result summaries remain the real implementations.
vi.mock("../runtime/connection_account", () => ({
  useConnectionAccount: () => null,
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = actual.useId() + ":state";
      if (!h.slots.has(index))
        h.slots.set(index, typeof initial === "function" ? initial() : initial);
      return [
        h.slots.get(index),
        (value: unknown) => {
          h.slots.set(
            index,
            typeof value === "function" ? value(h.slots.get(index)) : value,
          );
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = actual.useId() + ":ref";
      if (!h.slots.has(index)) h.slots.set(index, { current: initial });
      return h.slots.get(index);
    },
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
      const index = actual.useId() + ":effect";
      const previous = h.effects.get(index);
      if (
        !previous ||
        !deps ||
        deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
      ) {
        const next: { deps?: unknown[]; cleanup?: () => void } = { deps };
        h.effects.set(index, next);
        h.pending.push(() => {
          previous?.cleanup?.();
          next.cleanup = effect() || undefined;
        });
      }
    },
  };
});

// Capture the real callback without replacing or executing a component. Both
// JSX runtimes are covered so Vite's test transform does not decide the fixture.
function captureServiceChange(type: unknown, props: unknown) {
  if (typeof type !== "function" || type.name !== "AgentAuthSection") return;
  const summary = (
    props as {
      connection?: {
        apiSummary?: { props?: { onChangeService?: () => void } };
      };
    }
  )?.connection?.apiSummary;
  h.changeService = summary?.props?.onChangeService ?? null;
}
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  return {
    ...actual,
    jsx: (...args: Parameters<typeof actual.jsx>) => {
      captureServiceChange(args[0], args[1]);
      return actual.jsx(...args);
    },
    jsxs: (...args: Parameters<typeof actual.jsxs>) => {
      captureServiceChange(args[0], args[1]);
      return actual.jsxs(...args);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      captureServiceChange(args[0], args[1]);
      return actual.jsxDEV(...args);
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    if (command === "app_default_working_directory") {
      h.reads.push(command);
      return Promise.resolve("/fixture/work");
    }
    if (command === "auth_manual_get") {
      h.reads.push(command);
      return Promise.resolve(null);
    }
    return h.io();
  },
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.io }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.io }));
vi.mock("../runtime/agents", async (original) => ({
  ...(await original<typeof import("../runtime/agents")>()),
  authMethods: vi.fn(async () => ({
    methods: current().methods,
    canLogout: false,
  })),
}));
vi.mock("../runtime/preparation", async (original) => ({
  ...(await original<typeof import("../runtime/preparation")>()),
  getAgentPreparation: vi.fn(async () => current().preparation),
}));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: vi.fn(async () => current().services),
  getServiceCapabilities: vi.fn(async () => current().capability),
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/authentication", () => ({
  useAuthentication: () => new Map(),
  authenticationRequired: () => false,
  useAuthenticationActivity: () => current().job,
  subscribeAuthenticationChanges: () => () => {},
  invalidateAuthentication: h.execution,
  authenticationActivity: () => ({
    getSnapshot: () => current().job,
    subscribe: () => () => {},
    recheck: h.execution,
    cancel: h.execution,
    endConnection: h.execution,
    finishTerminal: h.execution,
  }),
}));
vi.mock("../runtime/auth_actions", () => ({
  beginAuthentication: h.execution,
  beginPreparationAction: h.execution,
  recheckAuthentication: h.execution,
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: () => current().thread,
  useThreadsSnapshot: () => ({ threads: new Map() }),
  threads: {
    getSnapshot: () => ({ threads: new Map() }),
    thread: () => current().thread,
    setConfig: h.execution,
  },
}));
vi.mock("../runtime/agent_preparation", async (original) => {
  const controller = {
    canPrepare: () => true,
    verified: () => false,
    invalidate: h.execution,
    prepare: h.fixtureModelRead,
    start: h.execution,
    stop: h.execution,
  };
  return {
    ...(await original<typeof import("../runtime/agent_preparation")>()),
    usePreparation: () => ({ state: current().snapshot, controller }),
  };
});
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
}));
vi.mock("./ProgramManager", async (original) => ({
  ...(await original<typeof import("./ProgramManager")>()),
  useProgramInventory: () => ({
    items: current().installations,
    error: null,
    loading: false,
    refresh: h.execution,
  }),
}));

import { AgentSetup } from "./AgentSetup";
import { preparationProgram } from "../runtime/agent_preparation";
import { freshThreadState } from "../runtime/session_projection";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = "/tmp/farfold-ui-consistency-html-2026-10-03";
const REFERENCE = resolve(ROOT, "../PRODUCT.md");
const CWD = "/fixture/work";
const method = (id: string, name: string, kind: string): AuthMethodInfo => ({
  id,
  name,
  kind,
  description: null,
  terminalCommand: null,
  envName: null,
});
const account = method("fixture-account", "ChatGPT 账号", "agent");
const key = {
  ...method("fixture-key", "OpenAI API Key", "api-key"),
  apiKeyProvider: "openai",
};
const action = {
  id: "fixture-terminal-settings",
  purpose: "service_configuration" as const,
  transport: "terminal" as const,
  command: "/fixture/agent",
  args: [],
  sourceUrl: "https://example.invalid/setup",
};
const service: Credential = {
  id: "fixture-service",
  label: "示例模型服务",
  provider: "example-service",
  endpoint: "https://example.invalid/v1",
  apiType: "chat-completions",
  models: ["example-fast", "example-reasoner"],
  revision: "fixture-revision",
  complete: true,
  deleting: false,
  grants: [],
};
function fixture(id: string, label: string, reference: string): Scenario {
  const card: AgentCardModel = {
    id: "fixture-agent",
    name: "示例 Agent",
    description: "",
    status: "connected",
    version: "1.0.0",
    authMethods: [],
    discoveredPath: null,
    registryVersion: null,
    source: "custom",
    installable: true,
    registerable: false,
    custom: true,
    handshake: null,
  };
  return {
    id,
    label,
    reference,
    card,
    progress: { step: 1, choice: "existing", accessStage: "method" },
    methods: [],
    preparation: { dependencies: [], links: [], actions: [] },
    capability: {
      apiTypes: [],
      validatedApiTypes: [],
      selectionScope: "connection",
      unavailableReason: null,
    },
    services: [service],
    installations: [
      {
        id: "fixture-current",
        source: "external",
        path: "/fixture/bin/agent",
        version: "1.0.0",
        managedRoot: null,
        programOnly: false,
        selected: true,
        inUse: true,
        canUninstall: false,
      },
    ],
    job: null,
    snapshot: {
      phase: "untested",
      input: null,
      threadKey: null,
      config: {},
      prompt: "",
      reply: "",
      error: null,
    },
    thread: null,
  };
}
function completed(s: Scenario, terminal = false) {
  s.progress = terminal
    ? {
        step: 1,
        choice: "existing",
        accessStage: "account",
        preparationActionId: action.id,
      }
    : {
        step: 1,
        choice: "login",
        accessStage: "account",
        authMethodId: account.id,
      };
  s.job = {
    attemptId: "fixture-completed",
    target: { agentId: s.card.id, cwd: CWD },
    operation: terminal
      ? {
          kind: "preparation",
          actionId: action.id,
          purpose: "service_configuration",
          title: "终端设置",
          completion: "exit_code",
        }
      : {
          kind: "authentication",
          methodId: account.id,
          title: account.name,
          completion: "exit_code",
          intent: "login",
        },
    phase: "completed",
    error: null,
    terminal: null,
    terminalOutcome: terminal
      ? { kind: "ended", code: 0, cancelled: false }
      : null,
    operationConfirmed: !terminal,
    checked: true,
    finishRequested: terminal,
  };
}
function selectedModel(s: Scenario) {
  const selection = s.progress.selection!;
  s.thread = {
    ...freshThreadState("fixture-thread", s.card.id, CWD, "fixture-native"),
    identity: "draft",
    cwd: CWD,
    serviceContext: selection.service
      ? JSON.stringify(selection.service)
      : undefined,
    configOptions: [
      {
        id: "model",
        name: "模型",
        category: "model",
        type: "select",
        currentValue: "example-fast",
        options: service.models.map((value) => ({ value, name: value })),
      },
    ],
  };
  s.snapshot = {
    ...s.snapshot,
    input: {
      agentId: s.card.id,
      agentName: s.card.name,
      cwd: CWD,
      program: preparationProgram(s.card),
      service: selection.service,
      config: selection.config,
    },
    threadKey: s.thread.key,
    config: selection.config,
  };
}
function scenarios() {
  const two = fixture(
    "01-account-key",
    "账号与指定密钥两种方式",
    "account-methods",
  );
  two.card = { ...two.card, id: "codex", name: "Codex", custom: false };
  two.methods = [account, key];
  two.progress = {
    step: 1,
    choice: "login",
    accessStage: "method",
    authMethodId: account.id,
  };
  const terminalApi = fixture(
    "02-terminal-api",
    "终端与模型 API 两种方式",
    "service-source",
  );
  terminalApi.preparation.actions = [action];
  terminalApi.capability.apiTypes = ["chat-completions"];
  terminalApi.progress.preparationActionId = action.id;
  const three = structuredClone(terminalApi);
  three.id = "03-three-methods";
  three.label = "账号、终端和模型 API 三种方式";
  three.reference = "connection-three-methods";
  three.methods = [account];
  three.progress = {
    step: 1,
    choice: "login",
    accessStage: "method",
    authMethodId: account.id,
  };
  const accountReady = structuredClone(two);
  accountReady.id = "04-account-summary";
  accountReady.label = "账号完成摘要";
  accountReady.reference = "chatgpt-success";
  completed(accountReady);
  const terminalReady = structuredClone(terminalApi);
  terminalReady.id = "05-terminal-summary";
  terminalReady.label = "终端设置检查完成摘要";
  terminalReady.reference = "terminal-checked";
  completed(terminalReady, true);
  const serviceStep = structuredClone(terminalApi);
  serviceStep.id = "06-service-step";
  serviceStep.label = "第二步只选择服务身份";
  serviceStep.reference = "service-select";
  serviceStep.progress = { step: 1, choice: "api", accessStage: "api" };
  const serviceReady = structuredClone(serviceStep);
  serviceReady.id = "07-service-summary";
  serviceReady.label = "模型服务已选择摘要";
  serviceReady.reference = "service-ready";
  serviceReady.progress.selection = {
    service: { id: service.id, revision: service.revision, model: "" },
    config: {},
  };
  const modelStep = structuredClone(serviceReady);
  modelStep.id = "08-model-step";
  modelStep.label = "第三步明确选择本次模型";
  modelStep.reference = "models-ready";
  modelStep.progress.step = 2;
  const modelReady = structuredClone(modelStep);
  modelReady.id = "09-model-selected";
  modelReady.label = "本次模型已选择，读取结果固定";
  modelReady.progress.selection = {
    service: {
      id: service.id,
      revision: service.revision,
      model: "example-fast",
    },
    config: { model: "example-fast" },
  };
  selectedModel(modelReady);
  const program = fixture(
    "10-program-list",
    "已断开后的程序清单",
    "program-candidate",
  );
  program.card.status = "installed";
  program.intent = "manage";
  program.progress.step = 0;
  program.installations[0].inUse = false;
  program.installations.push({
    id: "fixture-candidate",
    source: "managed",
    path: "/fixture/farfold/programs/candidate",
    version: "1.1.0",
    managedRoot: "/fixture/farfold/programs/candidate",
    programOnly: false,
    selected: false,
    inUse: false,
    canUninstall: true,
  });
  const connected = structuredClone(program);
  connected.id = "11-program-connected";
  connected.label = "已连接先断开后管理";
  connected.reference = "program-manager-connected";
  connected.card.status = "connected";
  connected.installations[0].inUse = true;
  connected.installations[1].canUninstall = false;
  const serviceEditing = structuredClone(serviceReady);
  serviceEditing.id = "12-service-editing";
  serviceEditing.label = "更换服务时再次显示服务选择";
  serviceEditing.reference = "service-select";
  serviceEditing.editService = true;
  const singleTerminal = structuredClone(terminalApi);
  singleTerminal.id = "13-single-terminal";
  singleTerminal.label = "单一终端方式也从选择页开始";
  singleTerminal.card = {
    ...singleTerminal.card,
    id: "opencode",
    name: "OpenCode",
    custom: false,
  };
  singleTerminal.capability.apiTypes = [];
  const keyDetail = structuredClone(two);
  keyDetail.id = "14-key-detail";
  keyDetail.label = "密钥方式的独立设置页";
  keyDetail.progress = {
    step: 1,
    choice: "login",
    accessStage: "account",
    authMethodId: key.id,
  };
  const staleApi = structuredClone(serviceStep);
  staleApi.id = "15-api-old-auth";
  staleApi.label = "无可选服务时不显示旧账号成功";
  staleApi.methods = [account];
  completed(staleApi);
  staleApi.services = [];
  staleApi.progress = { step: 1, choice: "api", accessStage: "api" };
  const prerequisite = {
    id: "fixture-program",
    name: "示例程序",
    status: "ready" as const,
    sourceUrl: "https://example.invalid/install",
    installable: true,
    managedLocation: "/fixture/program",
    checkCommand: "example --version",
    programVersion: "1.0.0",
    componentVersion: "0.1.0",
  };
  const readyProgram = structuredClone(connected);
  readyProgram.id = "16-program-ready";
  readyProgram.label = "已连接程序及折叠检查详情";
  readyProgram.card = {
    ...readyProgram.card,
    id: "pi",
    name: "Pi",
    custom: false,
  };
  readyProgram.preparation.dependencies = [prerequisite];
  const missingProgram = structuredClone(program);
  missingProgram.id = "17-program-missing";
  missingProgram.label = "缺少程序时显示安装入口";
  missingProgram.card = {
    ...missingProgram.card,
    id: "registry:autohand",
    name: "Autohand Code",
    custom: false,
  };
  missingProgram.preparation.dependencies = [
    { ...prerequisite, status: "missing" },
  ];
  return [
    singleTerminal,
    keyDetail,
    staleApi,
    readyProgram,
    missingProgram,
    two,
    terminalApi,
    three,
    accountReady,
    terminalReady,
    serviceStep,
    serviceReady,
    modelStep,
    modelReady,
    program,
    connected,
    serviceEditing,
  ];
}

const agents = () =>
  ({
    cards: [current().card],
    connectedCards: [current().card],
    busy: {},
    errors: {},
    installProgress: {},
    refresh: h.execution,
    connect: h.execution,
    disconnect: h.execution,
    install: h.execution,
    remove: h.execution,
    cancelInstall: h.execution,
    selectProgram: h.execution,
    selectInstallation: h.execution,
  }) as unknown as AgentsState;
function props() {
  const s = current();
  return {
    card: s.card,
    agents: agents(),
    cwd: CWD,
    intent: s.intent,
    progress: s.progress,
    onProgress: (progress: AgentSetupProgress) => {
      s.progress = progress;
    },
    onClose: () => {},
    onStart: () => {},
    onOpenApi: () => {},
  };
}
function render() {
  return renderToStaticMarkup(<AgentSetup {...props()} />);
}
async function settle(s: Scenario) {
  h.current = s;
  h.slots.clear();
  h.effects.clear();
  h.pending = [];
  h.changeService = null;
  for (let round = 0; round < 12; round++) {
    render();
    for (const effect of h.pending.splice(0)) effect();
    await Promise.resolve();
    await Promise.resolve();
  }
  if (s.editService) {
    // Capture and invoke the real parent's callback; do not replace a child
    // component or force an invented production state.
    expect(h.changeService).toBeTypeOf("function");
    h.changeService!();
    for (let round = 0; round < 3; round++) {
      render();
      for (const effect of h.pending.splice(0)) effect();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
  return render();
}
const digest = (data: string) =>
  createHash("sha256").update(data).digest("hex");
function styles() {
  const visited = new Set<string>();
  const paths: string[] = [];
  const blocks: string[] = [];
  const require = createRequire(import.meta.url);
  function expandCss(path: string, ancestors = new Set<string>()): string {
    if (ancestors.has(path))
      throw new Error("CSS import cycle in controlled renderer");
    if (!paths.includes(path)) paths.push(path);
    const next = new Set(ancestors).add(path);
    return readFileSync(path, "utf8").replace(
      /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/g,
      (_match, specifier: string, conditions: string) => {
        if (!specifier.startsWith(".") || conditions.trim())
          throw new Error("Unexpected non-local or conditional CSS import");
        return expandCss(resolve(dirname(path), specifier), next);
      },
    );
  }
  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    if (path.endsWith(".css")) {
      blocks.push(expandCss(path));
      return;
    }
    // A multiline regex can swallow a side-effect import after an export.
    // Read the actual syntax tree to preserve every static dependency edge.
    const module = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
    const imports: string[] = [];
    module.forEachChild((node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
    });
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) {
        if (specifier.endsWith(".css")) visit(require.resolve(specifier));
        continue;
      }
      const target = resolve(dirname(path), specifier);
      if (specifier.endsWith(".css")) visit(target);
      else {
        for (const ending of ["", ".tsx", ".ts"]) {
          try {
            readFileSync(target + ending, "utf8");
            visit(target + ending);
            break;
          } catch {
            /* Module aliases and package imports are not assets. */
          }
        }
      }
    }
  }
  visit(resolve(ROOT, "main.tsx"));
  return {
    paths: paths.map((path) =>
      path.startsWith(ROOT + "/")
        ? path.slice(ROOT.length + 1)
        : relative(resolve(ROOT, ".."), path),
    ),
    css: blocks.join("\n"),
  };
}
function documentHtml(markup: string, css: string, label: string) {
  const embedded = markup.replace(
    /src="(\/agents\/[^"]+)"/g,
    (_match, path: string) =>
      `src="data:image/svg+xml;base64,${Buffer.from(readFileSync(resolve(ROOT, "../public" + path), "utf8")).toString("base64")}"`,
  );
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'"><title>${label} · 受控静态状态</title><style>${css}</style></head><body><div id="root">${embedded}</div><script>document.querySelector('dialog').showModal();</script></body></html>`;
}
function sourceEvidence() {
  return [
    "components/AgentSetup.tsx",
    "components/AgentSetupProgram.tsx",
    "components/AgentAuthSection.tsx",
    "components/AgentConnectionPicker.tsx",
    "components/AgentServiceSection.tsx",
    "components/ServicePicker.tsx",
    "components/ServiceModelPicker.tsx",
    "components/ProgramManager.tsx",
    "components/AgentPrerequisites.tsx",
    "components/AgentSetup.r5-render.test.tsx",
  ].map((path) => ({
    path: "src/" + path,
    sha256: digest(readFileSync(resolve(ROOT, path), "utf8")),
  }));
}
function cleanup() {
  for (const effect of h.effects.values()) effect.cleanup?.();
  h.pending = [];
}
beforeEach(() => {
  h.reads = [];
  h.io.mockClear();
  h.execution.mockClear();
  h.fixtureModelRead.mockClear();
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("exports real shared components with synthetic state and no external IO", async () => {
  const { css, paths } = styles();
  expect(paths).toContain("r5-agent-access.css");
  expect(paths).toContain("agent-hub.css");
  expect(paths).toContain("styles-settings.css");
  expect(css).toContain(".agent-setup-dialog[open]");
  expect(css).toContain(".agent-setup-header {");
  expect(css).not.toMatch(/@import\s/);
  mkdirSync(OUTPUT, { recursive: true });
  const rows = [];
  for (const s of scenarios()) {
    cleanup();
    const markup = await settle(s);
    expect(markup).toContain('class="agent-setup-dialog"');
    expect(markup.match(/role="tab"/g)).toHaveLength(3);
    if (s.id.startsWith("01-") || s.id.startsWith("02-"))
      expect(markup.match(/type="radio"/g)).toHaveLength(3);
    if (s.id.startsWith("03-"))
      expect(markup.match(/type="radio"/g)).toHaveLength(4);
    if (s.id.startsWith("04-") || s.id.startsWith("05-")) {
      expect(markup).toContain("journey-connection-summary");
      expect(markup).not.toContain('type="radio"');
    }
    if (s.id.startsWith("06-")) {
      expect(markup).toContain("示例模型服务");
      expect(markup).not.toContain("example-fast");
    }
    if (s.id.startsWith("07-")) {
      expect(markup).toContain("agent-service-summary");
      expect(markup).not.toContain('class="service-picker"');
      expect(markup.match(/<h3[^>]*>模型 API 服务<\/h3>/g)).toHaveLength(1);
    }
    if (s.id.startsWith("12-")) {
      expect(markup).toContain('class="service-picker"');
      expect(markup).not.toContain("agent-service-summary");
      expect(markup).not.toContain("example-fast");
      expect(markup).not.toContain("继续选择模型");
    }
    if (s.id.startsWith("08-")) {
      expect(markup).toContain("service-model-picker");
      expect(markup).toContain('<option value="" disabled="" selected="">');
      expect(markup).not.toContain('<option value="example-fast" selected="">');
    }
    if (s.id.startsWith("09-"))
      expect(markup).toContain('<option value="example-fast" selected="">');
    if (s.id.startsWith("10-") || s.id.startsWith("11-"))
      expect(markup).toContain("program-manager");
    if (s.id.startsWith("11-")) expect(markup).toContain("更换程序");
    if (s.id.startsWith("13-")) {
      expect(markup.match(/type="radio"/g)).toHaveLength(2);
      expect(markup).not.toContain("启动设置终端");
    }
    if (s.id.startsWith("14-")) {
      expect(markup).not.toContain('type="radio"');
      expect(markup).toContain("返回接入方式");
    }
    if (s.id.startsWith("15-")) {
      expect(markup).not.toContain("ChatGPT");
      expect(markup).not.toContain("登录成功");
      expect(markup).not.toContain("继续选择模型");
    }
    if (s.id.startsWith("16-"))
      expect(markup).toContain('class="program-check-details"');
    if (s.id.startsWith("17-")) expect(markup).toContain("安装所需程序");
    const html = documentHtml(markup, css, s.label);
    writeFileSync(resolve(OUTPUT, s.id + ".html"), html);
    rows.push({
      id: s.id,
      label: s.label,
      referenceState: s.reference,
      file: s.id + ".html",
      sha256: digest(html),
      radioCount: (markup.match(/type="radio"/g) ?? []).length,
      fixture: true,
    });
  }
  expect(h.io).not.toHaveBeenCalled();
  expect(h.execution).not.toHaveBeenCalled();
  writeFileSync(
    resolve(OUTPUT, "manifest.json"),
    JSON.stringify(
      {
        kind: "controlled-production-SSR",
        viewport: { width: 1280, height: 820 },
        source:
          "real AgentSetup and child components; test-only transport/hook snapshots",
        limitations: [
          "All methods, services, receipts and program records are synthetic.",
          "No browser screenshot, interaction, Tauri execution, real authentication or 29-Agent parameter validation.",
          "Only showModal mounting is added to static HTML; component HTML, CSS and SVG assets are production outputs.",
        ],
        css: paths,
        cssSha256: digest(css),
        reference: {
          path: REFERENCE,
          sha256: digest(readFileSync(REFERENCE, "utf8")),
        },
        sourceHashes: sourceEvidence(),
        fixtureModelReadCount: h.fixtureModelRead.mock.calls.length,
        interceptedMetadataReads: [...new Set(h.reads)],
        rows,
      },
      null,
      2,
    ) + "\n",
  );
});

it("compares all 29 static identities with the authoritative plan and shared setup route", () => {
  const planPath = resolve(ROOT, "../docs/agent-first-release.md");
  const idsPath = resolve(ROOT, "../src-tauri/src/acp_client/first_release.rs");
  const catalogPath = resolve(ROOT, "../src-tauri/src/agent_catalog.rs");
  const hubPath = resolve(ROOT, "components/AgentHub.tsx");
  const plan = readFileSync(planPath, "utf8");
  const release = readFileSync(idsPath, "utf8");
  const catalog = readFileSync(catalogPath, "utf8");
  const hub = readFileSync(hubPath, "utf8");
  const matrix = plan.slice(plan.indexOf("## 当前保留的 29 项"));
  const declared = [
    ...matrix.matchAll(/^\|\s*([^|/]+?)\s*\/\s*`([a-z0-9-]+)`\s*\|/gm),
  ].map((row) => ({ name: row[1].trim(), registryId: row[2] }));
  const included =
    release.match(/const INCLUDED:[\s\S]*?=\s*&?\[([\s\S]*?)\];/)?.[1] ?? "";
  const ids = [...included.matchAll(/"([a-z0-9-]+)"/g)].map((row) => row[1]);
  expect(new Set(ids).size).toBe(29);
  expect(declared.map((row) => row.registryId)).toEqual(ids);
  expect(plan).toContain("29");
  const definitions = catalog.slice(
    catalog.indexOf("pub fn builtin_defs()"),
    catalog.indexOf("pub struct RegistryAgent"),
  );
  const builtinIds = new Map(
    [...definitions.matchAll(/AgentDef\s*\{([\s\S]*?)\n\s*\}/g)].flatMap(
      (row) => {
        const id = row[1].match(/\bid: "([^"]+)"/)?.[1];
        const registryId = row[1].match(/\bregistry_id: "([^"]+)"/)?.[1];
        return id && registryId ? [[registryId, id] as const] : [];
      },
    ),
  );
  expect(builtinIds.size).toBe(3);
  expect(catalog).toContain('format!("registry:{}", entry.id)');
  expect(catalog).toContain(".find(|def| def.registry_id == entry.id)");
  expect(hub.match(/<AgentSetup\b/g)).toHaveLength(1);
  expect(hub).toContain("card={selectedCard}");
  expect(hub).toContain("setSelected(agentId)");
  const rows = declared.map((row) => ({
    ...row,
    cardId: builtinIds.get(row.registryId) ?? "registry:" + row.registryId,
    route: "AgentHub selectedCard → shared AgentSetup",
    verification: "static source identity and route only",
    paused: row.registryId === "devin",
  }));
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(
    resolve(OUTPUT, "static-29.json"),
    JSON.stringify(
      {
        authority: "docs/agent-first-release.md 当前保留的 29 项",
        idsSource: "src-tauri/src/acp_client/first_release.rs INCLUDED",
        count: rows.length,
        missing: [],
        extra: [],
        identicalOrder: true,
        limitation:
          "No Agent-specific configuration, capability read, execution or authentication. Devin is string identity only.",
        sourceHashes: [planPath, idsPath, catalogPath, hubPath].map((path) => ({
          path: path.slice(ROOT.length - 3),
          sha256: digest(readFileSync(path, "utf8")),
        })),
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  expect(h.io).not.toHaveBeenCalled();
  expect(h.execution).not.toHaveBeenCalled();
});
