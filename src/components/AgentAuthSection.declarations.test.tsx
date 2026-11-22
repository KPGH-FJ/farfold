import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentAuthSectionProps } from "./AgentAuthSection";
import type { ThreadState } from "../runtime/session_types";
import type { PreparationInfo } from "../runtime/preparation";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  methods: vi.fn(),
  preparation: vi.fn<() => Promise<Partial<PreparationInfo>>>(async () => ({})),
  begin: vi.fn(),
  recheck: vi.fn(async () => {}),
  configure: vi.fn(),
  changed: vi.fn(async () => {}),
  reconnect: vi.fn(async () => {}),
  invoke: vi.fn(async () => "/confirmed"),
  openUrl: vi.fn(async (_url: string) => {}),
  status: new Set<(event: { payload: { agentId: string } }) => void>(),
  threads: new Map<string, ThreadState>(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots))
      h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[index],
      (value: unknown) => {
        h.slots[index] =
          typeof value === "function" ? value(h.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = { current: initial };
    return h.slots[index];
  },
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const index = h.cursor++;
    const previous = h.effects[index];
    if (
      !previous ||
      !deps ||
      deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
    ) {
      const next = { deps } as typeof previous;
      h.effects[index] = next;
      h.pending.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      _name: string,
      listener: (event: { payload: { agentId: string } }) => void,
    ) => {
      h.status.add(listener);
      return () => h.status.delete(listener);
    },
  ),
}));
vi.mock("../runtime/agents", () => ({ authMethods: h.methods }));
vi.mock("../runtime/connection_account", () => ({
  useConnectionAccount: () => null,
}));
vi.mock("../runtime/auth_actions", () => ({
  beginAuthentication: h.begin,
  beginPreparationAction: vi.fn(),
  recheckAuthentication: h.recheck,
}));
vi.mock("../runtime/authentication", () => ({
  useAuthenticationActivity: () => null,
  authenticationActivity: () => ({ getSnapshot: () => null }),
  invalidateAuthentication: vi.fn(),
}));
vi.mock("../runtime/sessions", () => ({
  useThreadsSnapshot: () => ({ threads: h.threads }),
  threads: { getSnapshot: () => ({ threads: h.threads }) },
}));
vi.mock("../runtime/preparation", async (original) => ({
  ...(await original<typeof import("../runtime/preparation")>()),
  getAgentPreparation: h.preparation,
}));
vi.mock("./ManualAuthSection", () => ({ ManualAuthSection: () => null }));
vi.mock("./InlineTerminal", () => ({ InlineTerminal: () => null }));
vi.mock("./AgentAccountLinks", () => ({ AgentAccountLinks: () => null }));
vi.mock("./AgentPreparationActions", () => ({
  AgentPreparationActions: () => null,
}));
vi.mock("./MethodApiKeySection", () => ({ MethodApiKeySection: () => null }));

import { AgentAuthSection } from "./AgentAuthSection";
import { AgentAccountHeading } from "./AgentAccountHeading";
import {
  AgentAccountExit,
  AgentAuthManage,
  AgentAuthWorkBlockers,
} from "./AgentAuthManage";
import { DangerConfirm } from "./DangerConfirm";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { AgentConnectionPicker } from "./AgentConnectionPicker";
import { AgentConnectionGuidance } from "./AgentConnectionGuidance";
import { AgentAccountLinks } from "./AgentAccountLinks";
import { ManualAuthSection } from "./ManualAuthSection";
import { MethodApiKeySection } from "./MethodApiKeySection";
import { AUTH_ACTIVITY_STRINGS as S } from "../runtime/auth_strings";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { STRINGS } from "../runtime/strings";
import { freshThreadState } from "../runtime/session_projection";
import { authMethodLabel } from "../runtime/auth_method";
import { METHOD_API_KEY_STRINGS } from "../runtime/method_api_key_strings";

type Element = ReactElement<Record<string, unknown>>;
let props: AgentAuthSectionProps;
function render(flushEffects = true) {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      if (child.type === AgentAccountHeading)
        visit(
          AgentAccountHeading(
            child.props as Parameters<typeof AgentAccountHeading>[0],
          ),
        );
      if (child.type === AgentConnectionPicker)
        visit(
          AgentConnectionPicker(
            child.props as Parameters<typeof AgentConnectionPicker>[0],
          ),
        );
      if (child.type === AgentConnectionGuidance)
        visit(
          AgentConnectionGuidance(
            child.props as Parameters<typeof AgentConnectionGuidance>[0],
          ),
        );
      if (child.type === AgentAuthManage)
        visit(
          AgentAuthManage(child.props as Parameters<typeof AgentAuthManage>[0]),
        );
      if (child.type === AgentAccountExit)
        visit(
          AgentAccountExit(
            child.props as Parameters<typeof AgentAccountExit>[0],
          ),
        );
      if (child.type === DangerConfirm)
        visit(
          DangerConfirm(child.props as Parameters<typeof DangerConfirm>[0]),
        );
      if (child.type === AgentAuthWorkBlockers)
        visit(
          AgentAuthWorkBlockers(
            child.props as Parameters<typeof AgentAuthWorkBlockers>[0],
          ),
        );
      visit(child.props.children as ReactNode);
    });
  visit(AgentAuthSection(props));
  if (flushEffects) for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
async function settled() {
  let nodes: Element[] = [];
  for (let round = 0; round < 6; round++) {
    nodes = render();
    await Promise.resolve();
  }
  return nodes;
}
async function openMethod() {
  const nodes = await settled();
  expect(h.begin).not.toHaveBeenCalled();
  return nodes;
}
function button(nodes: Element[], text: string) {
  return nodes.find(
    (node) => node.type === "button" && node.props.children === text,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
const response = (kind = "agent", name = "Original method") => ({
  methods: [{ id: "method", name, kind, envName: null, terminalCommand: null }],
  canLogout: false,
});
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
  h.status.clear();
  h.threads.clear();
  h.openUrl.mockReset().mockResolvedValue(undefined);
  h.methods.mockReset().mockResolvedValue(response());
  h.preparation.mockReset().mockResolvedValue({ actions: [] });
  props = {
    agentId: "declaration-view",
    cwd: "/original",
    onConfigureKey: h.configure,
    onChanged: h.changed,
    onReconnect: h.reconnect,
  };
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});

it("explains official external setup without choosing or executing its no-op method", async () => {
  const guidance = [
    {
      kind: "official_setup" as const,
      label: "Set up a provider",
      url: "https://example.com/official-setup",
      command: "setup configure",
      methodId: "method",
    },
  ];
  h.methods.mockResolvedValue(response("agent", "Configure Provider"));
  h.preparation.mockResolvedValue({
    connectionGuidance: guidance,
    officialMethodRoles: [
      { methodId: "method", kind: "agent", role: "external" },
    ],
  });
  const nodes = await settled();
  const picker = nodes.find((node) => node.type === AgentConnectionPicker)!;
  expect(picker.props.guidance).toEqual(guidance);
  expect(picker.props.options).toEqual([]);
  expect(
    button(nodes, R.accountContinue("Configure Provider")),
  ).toBeUndefined();
  expect(h.begin).not.toHaveBeenCalled();
});

it.each([
  "returned",
  "changed",
  "late",
  "return-before-acknowledgement",
  "focus-before-acknowledgement",
  "inactive",
  "failed",
  "busy",
  "busy-then-enabled",
  "busy-then-changed",
  "manual",
])(
  "checks official setup only when returning to its active connection (%s)",
  async (scenario) => {
    const foreground = new EventTarget();
    vi.stubGlobal("window", foreground);
    h.methods.mockResolvedValue({
      methods: [],
      canLogout: false,
      executionReady: true,
    });
    h.preparation.mockResolvedValue({
      connectionGuidance: [
        {
          kind: "official_setup",
          label: "Model service setup",
          url: "https://example.com/model",
        },
      ],
    });
    const nodes = await settled();
    const guide = nodes.find(
      (node) =>
        node.type === "button" &&
        Children.toArray(node.props.children as ReactNode).includes(
          "Model service setup",
        ),
    )!;
    foreground.dispatchEvent(new Event("focus"));
    expect(h.recheck).not.toHaveBeenCalled();
    if (scenario === "failed")
      h.openUrl.mockRejectedValueOnce(
        new Error("Could not open the setup page"),
      );
    const opening = deferred<void>();
    const delayed =
      scenario === "late" ||
      scenario === "return-before-acknowledgement" ||
      scenario === "focus-before-acknowledgement";
    if (delayed) h.openUrl.mockReturnValueOnce(opening.promise);
    (guide.props.onClick as () => void)();
    await settled();
    expect(h.openUrl).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/model",
    );
    if (scenario === "changed" || scenario === "late") props.cwd = "/other";
    if (scenario === "inactive") props.active = false;
    if (scenario.startsWith("busy")) props.busy = true;
    const afterOpen = await settled();
    if (scenario === "return-before-acknowledgement")
      foreground.dispatchEvent(new Event("blur"));
    if (
      scenario === "return-before-acknowledgement" ||
      scenario === "focus-before-acknowledgement"
    ) {
      foreground.dispatchEvent(new Event("focus"));
      expect(h.recheck).not.toHaveBeenCalled();
    }
    if (delayed) {
      opening.resolve();
      await settled();
    }
    expect(h.recheck).toHaveBeenCalledTimes(
      scenario === "return-before-acknowledgement" ? 1 : 0,
    );
    if (scenario === "manual")
      (
        button(afterOpen, R.checkOfficialSettings)!.props.onClick as () => void
      )();
    foreground.dispatchEvent(new Event("focus"));
    foreground.dispatchEvent(new Event("focus"));
    if (scenario === "busy-then-enabled" || scenario === "busy-then-changed") {
      expect(h.recheck).not.toHaveBeenCalled();
      if (scenario === "busy-then-changed") props.cwd = "/other";
      props.busy = false;
      await settled();
    }
    if (
      scenario === "returned" ||
      scenario === "manual" ||
      scenario === "return-before-acknowledgement" ||
      scenario === "focus-before-acknowledgement" ||
      scenario === "busy-then-enabled"
    ) {
      expect(h.recheck).toHaveBeenCalledExactlyOnceWith(
        { agentId: "declaration-view", cwd: "/original" },
        h.changed,
      );
    } else {
      expect(h.recheck).not.toHaveBeenCalled();
    }
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.reconnect).not.toHaveBeenCalled();
  },
);

it("labels a verified cached credential as reuse and executes its declared method", async () => {
  h.preparation.mockResolvedValue({
    officialMethodRoles: [{ methodId: "method", kind: "agent", role: "reuse" }],
  });
  const nodes = await settled();
  const picker = nodes.find((node) => node.type === AgentConnectionPicker)!;
  expect(picker.props.options).toEqual([
    expect.objectContaining({ group: R.groupReuse, description: R.reuseHint }),
  ]);
  (button(nodes, R.reuseContinue)!.props.onClick as () => void)();
  expect(h.begin).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "method", kind: "agent" }),
    }),
  );
});

it("preserves a current executable declaration with a different transport", async () => {
  h.methods.mockResolvedValue(response("terminal", "Current terminal setup"));
  h.preparation.mockResolvedValue({
    connectionGuidance: [
      {
        kind: "official_setup",
        label: "Set up a provider",
        url: "https://example.com/official-setup",
        methodId: "method",
      },
    ],
    officialMethodRoles: [
      { methodId: "method", kind: "agent", role: "external" },
    ],
  });
  const nodes = await settled();
  const picker = nodes.find((node) => node.type === AgentConnectionPicker)!;
  expect(picker.props.options).toEqual([
    expect.objectContaining({
      title: "Current terminal setup",
      group: R.groupTerminal,
    }),
  ]);
  expect(button(nodes, R.terminalStart)?.props.disabled).toBe(false);
});

it("rejects a login callback from a previous method-table request and executes only the refreshed declaration", async () => {
  const old = button(await openMethod(), R.accountContinue("Original method"))!;
  h.methods.mockResolvedValue({
    methods: [{ ...response().methods[0], id: "replacement" }],
    canLogout: false,
  });
  for (const notify of h.status)
    notify({ payload: { agentId: props.agentId } });
  const nodes = await settled();
  (old.props.onClick as () => void)();
  expect(h.begin).not.toHaveBeenCalled();
  (
    button(nodes, R.accountContinue("Original method"))!.props
      .onClick as () => void
  )();
  expect(h.begin).toHaveBeenCalledWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "replacement" }),
    }),
  );
});

it("rejects a login callback after another method is selected", async () => {
  h.methods.mockResolvedValue({
    methods: [response().methods[0], { ...response().methods[0], id: "other" }],
    canLogout: false,
  });
  props.methodId = "method";
  const old = button(await openMethod(), R.accountContinue("Original method"))!;
  props.methodId = "other";
  const nodes = await settled();
  (old.props.onClick as () => void)();
  expect(h.begin).not.toHaveBeenCalled();
  (
    button(nodes, R.accountContinue("Original method"))!.props
      .onClick as () => void
  )();
  expect(h.begin).toHaveBeenCalledWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "other" }),
    }),
  );
});

it("keeps non-executable equal-name declarations separate from the shared selector without executing either", async () => {
  h.methods.mockResolvedValue({
    methods: [
      {
        ...response("agent", "Original same name").methods[0],
        id: "official-login",
        rawPayload: { secret: "LABEL-PAYLOAD-CANARY" },
      },
      {
        ...response("environment", "Original same name").methods[0],
        id: "environment-info",
        envNames: ["PUBLIC_KEY_NAME"],
      },
    ],
    canLogout: false,
  });
  let nodes = await settled();
  const selector = nodes.find((node) => node.type === AgentConnectionPicker)!;
  expect(selector.props.options).toEqual([
    {
      id: JSON.stringify(["method", "official-login"]),
      title: "Original same name",
      description: R.accountHint,
      disabled: false,
      group: R.groupAgent,
    },
    {
      id: JSON.stringify(["method", "environment-info"]),
      title: "Original same name",
      description: `${S.environment}：PUBLIC_KEY_NAME`,
      disabled: true,
      group: R.groupEnvironment,
    },
  ]);
  expect(selector.props.value).toBe(
    JSON.stringify(["method", "official-login"]),
  );
  expect(h.begin).not.toHaveBeenCalled();
  expect(h.configure).not.toHaveBeenCalled();
  // Read-only information stays read-only even when requested explicitly.
  props.methodId = "environment-info";
  nodes = await settled();
  expect(
    button(nodes, R.accountContinue("Original same name")),
  ).toBeUndefined();
  expect(nodes.some((node) => node.props.children === "PUBLIC_KEY_NAME")).toBe(
    true,
  );
  expect(
    nodes.some((node) => node.props.children === "LABEL-PAYLOAD-CANARY"),
  ).toBe(false);
  expect(nodes.some((node) => node.type === ManualAuthSection)).toBe(true);
  expect(h.begin).not.toHaveBeenCalled();
  props.methodId = "official-login";
  nodes = await openMethod();
  (
    button(nodes, R.accountContinue("Original same name"))!.props
      .onClick as () => void
  )();
  expect(h.begin).toHaveBeenCalledWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "official-login", kind: "agent" }),
    }),
  );
  expect(h.configure).not.toHaveBeenCalled();
});

it("uses public IDs rather than list order for equal-name terminal labels and retains the chosen ID after refresh", async () => {
  const methods = [
    { ...response("terminal", "Same terminal").methods[0], id: "first-stable" },
    {
      ...response("terminal", "Same terminal").methods[0],
      id: "second-stable",
    },
  ];
  h.methods.mockResolvedValue({ methods, canLogout: false });
  let nodes = await settled();
  const selector = () =>
    nodes.find((node) => node.type === AgentConnectionPicker)!;
  const labels = () =>
    (selector().props.options as { id: string; title: string }[]).map(
      (option) => [option.id, option.title],
    );
  expect(labels()).toEqual([
    [JSON.stringify(["method", "first-stable"]), "Same terminal"],
    [JSON.stringify(["method", "second-stable"]), "Same terminal"],
  ]);
  (selector().props.onChange as (value: string) => void)(
    JSON.stringify(["method", "second-stable"]),
  );
  expect(h.begin).not.toHaveBeenCalled();
  h.methods.mockResolvedValue({
    methods: [...methods].reverse(),
    canLogout: false,
  });
  for (const listener of h.status)
    listener({ payload: { agentId: props.agentId } });
  nodes = await settled();
  expect(labels()).toEqual([
    [JSON.stringify(["method", "second-stable"]), "Same terminal"],
    [JSON.stringify(["method", "first-stable"]), "Same terminal"],
  ]);
  expect(selector().props.value).toBe(
    JSON.stringify(["method", "second-stable"]),
  );
  expect(h.begin).not.toHaveBeenCalled();
});

it.each(["environment", "unsupported"])(
  "shows a %s declaration without an automatic login or API route",
  async (kind) => {
    const reason = "此账号方式暂不能在这里自动完成，请查看官方说明。";
    h.methods.mockResolvedValue({
      methods: [
        {
          ...response(kind).methods[0],
          envNames: kind === "environment" ? ["PUBLIC_PROVIDER_KEY"] : [],
          unavailableReason: reason,
          rawPayload: { secret: "RAW-PAYLOAD-CANARY" },
        },
      ],
      canLogout: false,
    });
    const nodes = await settled();
    expect(button(nodes, R.accountContinue("Original method"))).toBeUndefined();
    expect(button(nodes, STRINGS.access.apiRoute)).toBeUndefined();
    expect(nodes.some((node) => node.props.children === reason)).toBe(true);
    expect(
      nodes.some((node) => node.props.children === "PUBLIC_PROVIDER_KEY"),
    ).toBe(kind === "environment");
    expect(
      nodes.some((node) => node.props.children === "RAW-PAYLOAD-CANARY"),
    ).toBe(false);
    const picker = nodes.find((node) => node.type === AgentConnectionPicker)!;
    expect(
      (picker.props.options as { disabled?: boolean; group?: string }[]).map(
        (option) => [option.group, option.disabled],
      ),
    ).toEqual([
      [kind === "environment" ? R.groupEnvironment : undefined, true],
    ]);
    expect(nodes.some((node) => node.props.children === P.moreLogin)).toBe(
      true,
    );
    const manual = nodes.find((node) => node.type === ManualAuthSection)!;
    expect(manual.props.disabled).toBe(false);
    expect(manual.props.declaredEnv).toBeNull();
    (manual.props.onRun as () => void)();
    expect(h.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { agentId: props.agentId, cwd: "/original", source: undefined },
        manual: true,
      }),
    );
    (button(nodes, R.connection)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledOnce());
    expect(h.configure).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  },
);

it("does not turn an environment kind without a reason into ordinary authenticate", async () => {
  h.methods.mockResolvedValue(response("environment"));
  const nodes = await settled();
  expect(button(nodes, R.accountContinue("Original method"))).toBeUndefined();
  expect(button(nodes, STRINGS.access.apiRoute)).toBeUndefined();
  expect(h.begin).not.toHaveBeenCalled();
});

it.each(["empty", "filtered-api"])(
  "uses the same zero-method account fallback for %s declarations",
  async (declaration) => {
    props = { ...props, apiState: "unsupported", methodId: "method" };
    h.methods.mockResolvedValue({
      methods: declaration === "empty" ? [] : response("api-key").methods,
      canLogout: false,
    });
    const nodes = await settled();
    expect(nodes.some((node) => node.type === "select")).toBe(false);
    expect(button(nodes, R.accountContinue("Original method"))).toBeUndefined();
    expect(button(nodes, R.continue)).toBeUndefined();
    expect(button(nodes, STRINGS.access.apiRoute)).toBeUndefined();
    expect(
      nodes.some((node) => node.props.children === STRINGS.agents.auth.none),
    ).toBe(true);
    const links = nodes.find((node) => node.type === AgentAccountLinks)!;
    expect(links).toBeDefined();
    expect(links.props.methodIds).toBeUndefined();
    const manual = nodes.find((node) => node.type === ManualAuthSection)!;
    expect(manual).toBeDefined();
    expect(manual.props.methodId).toBe("manual");
    expect(manual.props.disabled).toBe(false);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
    (manual.props.onRun as () => void)();
    expect(h.begin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: { id: "manual", kind: "terminal" },
        manual: true,
      }),
    );
    expect(h.configure).not.toHaveBeenCalled();
  },
);

it("keeps an executable method-level Key route independent of API service support", async () => {
  props = { ...props, apiState: "unsupported" };
  h.methods.mockResolvedValue({
    methods: [
      { ...response("api-key").methods[0], apiKeyProvider: "public-provider" },
    ],
    canLogout: false,
  });
  let nodes = await settled();
  const initial = button(nodes, R.keyContinue("Original method"))!;
  expect(initial).toBeDefined();
  (initial.props.onClick as () => void)();
  nodes = await settled();
  const key = nodes.find((node) => node.type === MethodApiKeySection)!;
  expect(key).toBeDefined();
  expect(key.props.provider).toBe("public-provider");
  expect(button(nodes, STRINGS.access.apiRoute)).toBeUndefined();
  expect(h.begin).not.toHaveBeenCalled();
  (key.props.onStart as (value: { id: string; revision: string }) => void)({
    id: "method-key-ref",
    revision: "current-revision",
  });
  expect(h.begin).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: expect.objectContaining({
        id: "method",
        kind: "api-key",
        apiKeyProvider: "public-provider",
      }),
      credentialId: "method-key-ref",
      credentialRevision: "current-revision",
    }),
  );
  expect(h.configure).not.toHaveBeenCalled();
});

it("distinguishes a protocol Key login from a same-name API configuration route", () => {
  const methods = [
    {
      ...response("api-key", "Same provider").methods[0],
      id: "method-key",
      apiKeyProvider: "provider",
    },
    {
      ...response("api-key", "Same provider").methods[0],
      id: "api-configuration",
    },
  ];
  expect(authMethodLabel(methods[0], methods)).toBe(
    `Same provider（${METHOD_API_KEY_STRINGS.methodLabel} · method-key）`,
  );
  expect(authMethodLabel(methods[1], methods)).toBe(
    `Same provider（${S.methodApi} · api-configuration）`,
  );
});

it("shows the remaining terminal choice before its detail when the saved API method is filtered out", async () => {
  props = { ...props, apiState: "unsupported", methodId: "api" };
  h.methods.mockResolvedValue({
    methods: [
      { ...response("api-key").methods[0], id: "api" },
      {
        ...response("terminal", "Official terminal").methods[0],
        id: "terminal",
      },
    ],
    canLogout: false,
  });
  let nodes = await settled();
  expect(nodes.some((node) => node.type === "select")).toBe(false);
  expect(button(nodes, STRINGS.access.apiRoute)).toBeUndefined();
  expect(
    nodes.some((node) => node.props.children === STRINGS.agents.auth.none),
  ).toBe(false);
  expect(
    nodes.find((node) => node.type === ManualAuthSection)?.props.methodId,
  ).toBe("terminal");
  const login = button(nodes, R.terminalStart)!;
  expect(login.props.disabled).toBe(false);
  expect(h.begin).not.toHaveBeenCalled();
  (login.props.onClick as () => void)();
  expect(h.begin).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "terminal", kind: "terminal" }),
      manual: false,
    }),
  );
  expect(h.configure).not.toHaveBeenCalled();
});

it("offers only the remaining executable methods before choosing among multiple routes", async () => {
  props = { ...props, apiState: "unsupported", methodId: "api" };
  h.methods.mockResolvedValue({
    methods: [
      { ...response("api-key").methods[0], id: "api" },
      { ...response("agent").methods[0], id: "agent" },
      { ...response("terminal").methods[0], id: "terminal" },
    ],
    canLogout: false,
  });
  let nodes = await settled();
  const selector = nodes.find((node) => node.type === AgentConnectionPicker)!;
  expect(selector.props.value).toBe(JSON.stringify(["method", "agent"]));
  expect(
    (selector.props.options as { id: string }[]).map((option) => option.id),
  ).toEqual([
    JSON.stringify(["method", "agent"]),
    JSON.stringify(["method", "terminal"]),
  ]);
  expect(button(nodes, STRINGS.access.apiRoute)).toBeUndefined();
  expect(
    button(nodes, R.accountContinue("Original method"))?.props.disabled,
  ).toBe(false);
  expect(button(nodes, R.terminalStart)).toBeUndefined();
  expect(
    nodes.find((node) => node.type === ManualAuthSection)?.props.methodId,
  ).toBe("agent");
  expect(h.begin).not.toHaveBeenCalled();
  expect(h.configure).not.toHaveBeenCalled();
  props = { ...props, methodId: "terminal" };
  nodes = await settled();
  expect(button(nodes, R.terminalStart)?.props.disabled).toBe(false);
  expect(
    nodes.find((node) => node.type === ManualAuthSection)?.props.methodId,
  ).toBe("terminal");
  expect(h.begin).not.toHaveBeenCalled();
});

it("requires a separate confirmation before leaving the account and leaves the next login to the user", async () => {
  h.methods.mockResolvedValue({ ...response(), canLogout: true });
  (button(await settled(), S.switchAccount)!.props.onClick as () => void)();
  expect(h.begin).not.toHaveBeenCalled();
  const confirmation = button(await settled(), S.switchConfirm)!;
  expect(confirmation.props.disabled).toBe(false);
  (confirmation.props.onClick as () => void)();
  expect(h.begin).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      target: { agentId: props.agentId, cwd: "/original", source: undefined },
      method: { id: "logout", kind: "agent" },
      logout: true,
      switchAccount: true,
      manual: false,
    }),
  );
  expect(button(await settled(), S.switchConfirm)).toBeUndefined();
});

it("keeps supported logout independent but hides switching without an executable login method", async () => {
  h.methods.mockResolvedValue({ ...response("environment"), canLogout: true });
  let nodes = await settled();
  expect(button(nodes, STRINGS.agents.auth.logout)?.props.disabled).toBe(false);
  expect(button(nodes, S.switchAccount)).toBeUndefined();
  h.methods.mockResolvedValue({ ...response("terminal"), canLogout: true });
  for (const listener of h.status)
    listener({ payload: { agentId: props.agentId } });
  nodes = await settled();
  expect(button(nodes, S.switchAccount)?.props.disabled).toBe(false);
  const work = freshThreadState(
    "running-work",
    props.agentId,
    "/original",
    "existing",
  );
  work.running = true;
  h.threads.set(work.key, work);
  nodes = await settled();
  expect(button(nodes, S.switchAccount)?.props.disabled).toBe(true);
  expect(button(nodes, STRINGS.agents.auth.logout)?.props.disabled).toBe(true);
  expect(h.begin).not.toHaveBeenCalled();
});

it("rejects a stale exit confirmation when work starts before the click", async () => {
  h.methods.mockResolvedValue({ ...response(), canLogout: true });
  (
    button(await settled(), STRINGS.agents.auth.logout)!.props
      .onClick as () => void
  )();
  const confirmation = button(await settled(), S.confirmLogout)!;
  const work = freshThreadState(
    "other-work",
    props.agentId,
    "/elsewhere",
    "existing",
  );
  work.running = true;
  h.threads.set(work.key, work);
  (confirmation.props.onClick as () => void)();
  expect(h.begin).not.toHaveBeenCalled();
  expect(button(await settled(), S.confirmLogout)?.props.disabled).toBe(true);
});

it("rejects a stale exit confirmation after the current connection declarations change", async () => {
  h.methods.mockResolvedValue({ ...response(), canLogout: true });
  (button(await settled(), S.switchAccount)!.props.onClick as () => void)();
  const confirmation = button(await settled(), S.switchConfirm)!;
  h.methods.mockResolvedValue(response());
  for (const listener of h.status)
    listener({ payload: { agentId: props.agentId } });
  (confirmation.props.onClick as () => void)();
  expect(h.begin).not.toHaveBeenCalled();
  const updated = await settled();
  expect(button(updated, S.switchAccount)).toBeUndefined();
  expect(button(updated, STRINGS.agents.auth.logout)).toBeUndefined();
});

it("queries each actual directory/source and hides the previous target before its new query completes", async () => {
  const nodes = await openMethod();
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/original",
    source: undefined,
  });
  const previousClick = button(nodes, R.accountContinue("Original method"))!
    .props.onClick as () => void;
  const next = deferred<ReturnType<typeof response>>();
  h.methods.mockReturnValueOnce(next.promise);
  props = { ...props, cwd: "/new-location" };
  const changing = render();
  expect(
    button(changing, R.accountContinue("Original method")),
  ).toBeUndefined();
  previousClick();
  expect(h.begin).not.toHaveBeenCalled();
  await settled();
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/new-location",
    source: undefined,
  });
  next.resolve(response("terminal", "New location method"));
  expect(
    (await settled()).some(
      (node) =>
        node.type === AgentConnectionPicker &&
        (node.props.options as { id: string }[]).some(
          (option) => option.id === JSON.stringify(["method", "method"]),
        ),
    ),
  ).toBe(true);
  props = { ...props, source: "selected-api" };
  await settled();
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/new-location",
    source: "selected-api",
  });
  expect(h.begin).not.toHaveBeenCalled();
});

it("ignores a late response from another directory without replacing current methods", async () => {
  const old = deferred<ReturnType<typeof response>>();
  h.methods.mockReturnValueOnce(old.promise);
  await settled();
  props = { ...props, cwd: "/current" };
  h.methods.mockResolvedValueOnce(response("terminal", "Current method"));
  await settled();
  old.resolve(response("agent", "Late wrong method"));
  const nodes = await settled();
  expect(
    nodes.find((node) => node.type === AgentConnectionPicker)?.props
      .options as { id: string; title: string }[],
  ).toEqual([
    {
      id: JSON.stringify(["method", "method"]),
      title: "Current method",
      description: R.terminalHint,
      disabled: false,
      group: R.groupTerminal,
    },
  ]);
  expect(
    nodes.some((node) => node.props.children === "Late wrong method"),
  ).toBe(false);
});

it("queries the resolved default location rather than only an Agent-wide cache", async () => {
  props = { ...props, cwd: undefined };
  await settled();
  expect(h.invoke).toHaveBeenCalledWith("app_default_working_directory");
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/confirmed",
    source: undefined,
  });
});

it("refreshes a display-only cache when this Agent connection changes, without running it", async () => {
  const cached = response();
  Object.assign(cached.methods[0], {
    unavailableReason: "请重新检查连接后再选择登录方式",
  });
  h.methods.mockResolvedValueOnce(cached);
  let nodes = await settled();
  expect(button(nodes, R.accountContinue("Original method"))).toBeUndefined();
  const calls = h.methods.mock.calls.length;
  for (const listener of h.status)
    listener({ payload: { agentId: "other-agent" } });
  await settled();
  expect(h.methods).toHaveBeenCalledTimes(calls);
  for (const listener of h.status)
    listener({ payload: { agentId: props.agentId } });
  nodes = await settled();
  expect(h.methods).toHaveBeenCalledTimes(calls + 1);
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/original",
    source: undefined,
  });
  expect(
    button(nodes, R.accountContinue("Original method"))!.props.disabled,
  ).toBe(false);
  expect(h.begin).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
});

it.each(["agent", "api-key"])(
  "invalidates an earlier %s button immediately when connection facts change",
  async (kind) => {
    h.methods.mockResolvedValueOnce(response(kind));
    const nodes = await openMethod();
    const label =
      kind === "api-key"
        ? R.keyContinue("Original method")
        : R.accountContinue("Original method");
    const click = button(nodes, label)!.props.onClick as () => void;
    for (const listener of h.status)
      listener({ payload: { agentId: props.agentId } });
    // Click the previously enabled control before React/effects can rerender.
    click();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
  },
);

it("keeps another declared terminal choice usable beside read-only environment information", async () => {
  h.methods.mockResolvedValue({
    methods: [
      {
        ...response("environment", "Environment").methods[0],
        id: "environment",
        envNames: ["PUBLIC_PROVIDER_KEY"],
      },
      {
        ...response("terminal", "Official terminal").methods[0],
        id: "terminal",
      },
    ],
    canLogout: false,
  });
  props.methodId = "environment";
  let nodes = await settled();
  expect(
    nodes.some((node) => node.props.children === "PUBLIC_PROVIDER_KEY"),
  ).toBe(true);
  expect(button(nodes, R.accountContinue("Official terminal"))).toBeUndefined();
  const selector = nodes.find((node) => node.type === AgentConnectionPicker)!;
  expect(
    (selector.props.options as { id: string }[]).map((option) => option.id),
  ).toEqual([
    JSON.stringify(["method", "terminal"]),
    JSON.stringify(["method", "environment"]),
  ]);
  props.methodId = "terminal";
  nodes = await settled();
  const start = button(nodes, R.terminalStart)!;
  expect(start.props.disabled).toBe(false);
  (start.props.onClick as () => void)();
  expect(h.begin).toHaveBeenCalledWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "terminal", kind: "terminal" }),
    }),
  );
  expect(h.configure).not.toHaveBeenCalled();
});

it("keeps an explicit failed account check visible when status events refresh its declaration table", async () => {
  h.recheck.mockRejectedValueOnce(new Error("此次账号连接检查失败，请重试"));
  (button(await settled(), R.connection)!.props.onClick as () => void)();
  await settled();
  for (const listener of h.status)
    listener({ payload: { agentId: props.agentId } });
  const nodes = await settled();
  expect(
    nodes.some(
      (node) =>
        node.props.role === "alert" &&
        Children.toArray(node.props.children as ReactNode).includes(
          "此次账号连接检查失败，请重试",
        ),
    ),
  ).toBe(true);
  expect(h.begin).not.toHaveBeenCalled();
});

const connection = (
  overrides: Partial<NonNullable<AgentAuthSectionProps["connection"]>> = {},
): NonNullable<AgentAuthSectionProps["connection"]> => ({
  choice: "existing",
  stage: "method",
  apiAvailable: true,
  onChoice: vi.fn(),
  onStageChange: vi.fn(),
  apiContent: null,
  ...overrides,
});

it("shares a variable method list with declared account, key, terminal and compatible API choices without running them", async () => {
  h.methods.mockResolvedValue({
    methods: [
      { ...response("agent", "Account").methods[0], id: "account" },
      {
        ...response("api-key", "Provider key").methods[0],
        id: "provider-key",
        apiKeyProvider: "openai",
      },
      {
        ...response("terminal", "Official settings").methods[0],
        id: "terminal",
        purpose: "setup",
        completion: "return_and_verify",
      },
    ],
    canLogout: false,
  });
  props.connection = connection();
  props.apiState = "supported";
  const nodes = await settled();
  const picker = nodes.find((node) => node.type === AgentConnectionPicker)!;
  expect(
    (
      picker.props.options as {
        id: string;
        title: string;
        description: string;
      }[]
    ).map((option) => [option.id, option.title, option.description]),
  ).toEqual([
    [JSON.stringify(["existing"]), R.existing, R.existingHint],
    [JSON.stringify(["method", "account"]), "Account", R.accountHint],
    [
      JSON.stringify(["method", "terminal"]),
      "Official settings",
      R.terminalHint,
    ],
    [JSON.stringify(["method", "provider-key"]), "Provider key", R.keyHint],
    [JSON.stringify(["api"]), R.api, R.apiHint],
  ]);
  (picker.props.onChange as (id: string) => void)(
    JSON.stringify(["method", "provider-key"]),
  );
  expect(props.connection.onChoice).toHaveBeenCalledExactlyOnceWith(
    "login",
    "provider-key",
  );
  // An API-key method opens its form directly instead of a confirm page.
  expect(props.connection.onStageChange).toHaveBeenCalledExactlyOnceWith(
    "account",
  );
  expect(h.begin).not.toHaveBeenCalled();
  expect(h.configure).not.toHaveBeenCalled();
});

it.each(["unknown", "unsupported"] as const)(
  "keeps API capability %s honest in the shared connection list",
  async (apiState) => {
    props.apiState = apiState;
    props.connection = connection({ apiAvailable: false });
    const picker = (await settled()).find(
      (node) => node.type === AgentConnectionPicker,
    )!;
    const api = (
      picker.props.options as { id: string; disabled: boolean }[]
    ).find((option) => option.id === JSON.stringify(["api"]));
    if (apiState === "unknown") expect(api).toMatchObject({ disabled: true });
    else expect(api).toBeUndefined();
    (picker.props.onChange as (id: string) => void)(JSON.stringify(["api"]));
    expect(props.connection.onChoice).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
  },
);

it("rejects an old selector callback after refreshed declarations remove its method", async () => {
  props.onMethodChange = vi.fn();
  h.methods.mockResolvedValue({
    methods: [
      response().methods[0],
      { ...response().methods[0], id: "removed" },
    ],
    canLogout: false,
  });
  const old = (await settled()).find(
    (node) => node.type === AgentConnectionPicker,
  )!;
  h.methods.mockResolvedValue({
    methods: [{ ...response().methods[0], id: "replacement" }],
    canLogout: false,
  });
  for (const notify of h.status)
    notify({ payload: { agentId: props.agentId } });
  await settled();
  (old.props.onChange as (id: string) => void)(
    JSON.stringify(["method", "removed"]),
  );
  expect(props.onMethodChange).not.toHaveBeenCalled();
  expect(h.begin).not.toHaveBeenCalled();
});

it("rejects an old selector callback when the visible target changes before effect cleanup", async () => {
  props.onMethodChange = vi.fn();
  const old = (await settled()).find(
    (node) => node.type === AgentConnectionPicker,
  )!;
  props = { ...props, cwd: "/new-target" };
  render(false);
  (old.props.onChange as (id: string) => void)(
    JSON.stringify(["method", "method"]),
  );
  expect(props.onMethodChange).not.toHaveBeenCalled();
  expect(h.begin).not.toHaveBeenCalled();
});

it("uses a single footer action and rejects its old method callback after another choice", async () => {
  h.methods.mockResolvedValue({
    methods: [
      response().methods[0],
      { ...response().methods[0], id: "other", name: "Other" },
    ],
    canLogout: false,
  });
  const primary = vi.fn();
  props.methodId = "method";
  props.connection = connection({
    choice: "login",
    stage: "account",
    onPrimaryChange: primary,
  });
  let nodes = await settled();
  const old = primary.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  expect(old.label).toBe(R.accountContinue("Original method"));
  expect(old.disabled).toBe(false);
  expect(button(nodes, old.label)).toBeUndefined();
  props = { ...props, methodId: "other" };
  nodes = await settled();
  old.run();
  expect(h.begin).not.toHaveBeenCalled();
  const current = primary.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  expect(current.label).toBe(R.accountContinue("Other"));
  current.run();
  expect(h.begin).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "other" }),
    }),
  );
});

it("rejects a prior API footer action when capability becomes unsupported", async () => {
  const primary = vi.fn(),
    stage = vi.fn();
  props.apiState = "supported";
  props.connection = connection({
    choice: "api",
    onStageChange: stage,
    onPrimaryChange: primary,
  });
  await settled();
  const old = primary.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  expect(old.label).toBe(R.continue);
  expect(old.disabled).toBe(false);
  props = {
    ...props,
    apiState: "unsupported",
    connection: { ...props.connection!, apiAvailable: false },
  };
  await settled();
  old.run();
  expect(stage).not.toHaveBeenCalled();
  expect(h.begin).not.toHaveBeenCalled();
  expect(h.configure).not.toHaveBeenCalled();
});

it("shows borrowed declarations without a connect button and connects silently before running the method", async () => {
  const connect = vi.fn(async () => {});
  props.onConnect = connect;
  h.methods.mockResolvedValue({ ...response(), executionReady: false });
  let nodes = await settled();
  const picker = nodes.find((node) => node.type === AgentConnectionPicker)!;
  expect(
    (picker.props.options as { id: string }[]).map((option) => option.id),
  ).toEqual([JSON.stringify(["method", "method"])]);
  const login = button(nodes, R.accountContinue("Original method"))!;
  expect(login.props.disabled).toBe(false);
  expect(connect).not.toHaveBeenCalled();
  h.methods.mockResolvedValue({
    methods: [{ ...response().methods[0], name: "Fresh method" }],
    canLogout: false,
    executionReady: true,
  });
  (login.props.onClick as () => void)();
  nodes = await settled();
  expect(connect).toHaveBeenCalledOnce();
  expect(h.methods).toHaveBeenCalledTimes(2);
  expect(h.begin).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "method", name: "Fresh method" }),
    }),
  );
});

it("asks for a fresh choice when the declaration changes during silent connect", async () => {
  props.onConnect = vi.fn(async () => {});
  h.methods.mockResolvedValue({ ...response(), executionReady: false });
  const nodes = await settled();
  h.methods.mockResolvedValue({
    methods: [{ ...response().methods[0], id: "replacement" }],
    canLogout: false,
    executionReady: true,
  });
  (
    button(nodes, R.accountContinue("Original method"))!.props
      .onClick as () => void
  )();
  const updated = await settled();
  expect(h.begin).not.toHaveBeenCalled();
  expect(
    updated.some(
      (node) =>
        node.props.role === "alert" &&
        Children.toArray(node.props.children as ReactNode).includes(
          R.methodsChanged,
        ),
    ),
  ).toBe(true);
});

it("shows a thrown connection failure and keeps the action retryable", async () => {
  props.onConnect = vi.fn(async () => {
    throw new Error("连接失败");
  });
  h.methods.mockResolvedValue({ ...response(), executionReady: false });
  const nodes = await settled();
  (
    button(nodes, R.accountContinue("Original method"))!.props
      .onClick as () => void
  )();
  const updated = await settled();
  expect(h.begin).not.toHaveBeenCalled();
  expect(
    updated.some(
      (node) =>
        node.props.role === "alert" &&
        Children.toArray(node.props.children as ReactNode).includes("连接失败"),
    ),
  ).toBe(true);
  expect(
    button(updated, R.accountContinue("Original method"))!.props.disabled,
  ).toBe(false);
});

it("reports an incomplete connection when the refreshed declaration still cannot execute", async () => {
  props.onConnect = vi.fn(async () => {});
  h.methods.mockResolvedValue({ ...response(), executionReady: false });
  const nodes = await settled();
  (
    button(nodes, R.accountContinue("Original method"))!.props
      .onClick as () => void
  )();
  const updated = await settled();
  expect(h.begin).not.toHaveBeenCalled();
  expect(
    updated.some(
      (node) =>
        node.props.role === "alert" &&
        Children.toArray(node.props.children as ReactNode).includes(
          R.connectionIncomplete,
        ),
    ),
  ).toBe(true);
});

it("does not connect when a ready declaration can execute directly", async () => {
  const connect = vi.fn(async () => {});
  props.onConnect = connect;
  h.methods.mockResolvedValue({ ...response(), executionReady: true });
  const nodes = await settled();
  (
    button(nodes, R.accountContinue("Original method"))!.props
      .onClick as () => void
  )();
  expect(h.begin).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "method" }),
    }),
  );
  expect(connect).not.toHaveBeenCalled();
});
