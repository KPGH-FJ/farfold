import { ConnectionAccount } from "./ConnectionAccount";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentAuthSectionProps } from "./AgentAuthSection";
import type { ThreadState } from "../runtime/session_types";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  methods: vi.fn(),
  prepare: vi.fn(),
  preparation: vi.fn(),
  recheck: vi.fn(async (_target: unknown, changed: () => Promise<void>) => {
    await changed();
  }),
  changed: vi.fn(async () => {}),
  openModels: vi.fn(),
  threads: new Map<string, ThreadState>(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../runtime/agents", () => ({ authMethods: h.methods }));
vi.mock("../runtime/auth_actions", () => ({
  beginAuthentication: vi.fn(),
  beginPreparationAction: h.prepare,
  recheckAuthentication: h.recheck,
}));
vi.mock("../runtime/sessions", () => ({
  useThreadsSnapshot: () => ({ threads: h.threads }),
  threads: { getSnapshot: () => ({ threads: h.threads }) },
}));
vi.mock("../runtime/preparation", () => ({
  getAgentPreparation: h.preparation,
}));
vi.mock("./ManualAuthSection", () => ({ ManualAuthSection: () => null }));
vi.mock("./InlineTerminal", () => ({ InlineTerminal: () => null }));
vi.mock("./AgentAccountLinks", () => ({ AgentAccountLinks: () => null }));
vi.mock("./AgentPreparationActions", () => ({
  AgentPreparationActions: () => null,
}));
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentAccountHeading } from "./AgentAccountHeading";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { AgentConnectionPicker } from "./AgentConnectionPicker";
import { InlineTerminal } from "./InlineTerminal";
import { AgentPreparationActions } from "./AgentPreparationActions";
import { MethodApiKeySection } from "./MethodApiKeySection";
import { authenticationActivity } from "../runtime/authentication";
import { beginAuthentication } from "../runtime/auth_actions";
import { AUTH_ACTIVITY_STRINGS as A } from "../runtime/auth_strings";
import { PREPARATION_ACTION_STRINGS as S } from "../runtime/preparation_action_strings";
import { STRINGS } from "../runtime/strings";
import { freshThreadState } from "../runtime/session_projection";
type Element = ReactElement<Record<string, unknown>>;
let sequence = 0,
  agentId: string;
function render(
  source?: string,
  props: Partial<AgentAuthSectionProps> = {},
  flushEffects = true,
) {
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
      visit(child.props.children as ReactNode);
    });
  visit(
    AgentAuthSection({
      agentId,
      cwd: "/original",
      source,
      onConfigureKey() {},
      onChanged: h.changed,
      onReconnect: async () => {},
      canOpenModels: true,
      onOpenModels: h.openModels,
      ...props,
    }),
  );
  if (flushEffects) for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
async function settled(
  source?: string,
  props: Partial<AgentAuthSectionProps> = {},
) {
  let nodes: Element[] = [];
  for (let i = 0; i < 6; i++) {
    nodes = render(source, props);
    await Promise.resolve();
  }
  return nodes;
}
const button = (nodes: Element[], label: string) =>
  nodes.find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const login = {
  kind: "authentication" as const,
  methodId: "method",
  title: "Account login",
  completion: "exit_code" as const,
};
const loginSuccess = (nodes: Element[]) =>
  nodes.some((node) =>
    [
      R.confirmed,
      R.keyConfirmed,
      A.loginConfirmedChecking,
      A.loginConfirmedCheckFailed,
    ].some((text) => text === String(node.props.children)),
  );
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
  h.threads.clear();
  agentId = `configuration-view-${++sequence}`;
  h.methods.mockResolvedValue({ methods: [], canLogout: false });
  h.preparation.mockReset().mockResolvedValue({ actions: [] });
});

it.each(["account"])(
  "shows a dedicated restored protocol login detail without executing it (method %s)",
  async (methodId) => {
    h.methods.mockResolvedValue({
      methods: [
        { id: "account", kind: "agent", name: "Account" },
        { id: "other", kind: "agent", name: "Other account" },
      ],
      canLogout: false,
    });
    const receive = vi.fn(),
      choose = vi.fn();
    const nodes = await settled(undefined, {
      methodId,
      apiState: "unsupported",
      connection: {
        choice: "login",
        stage: "account",
        apiAvailable: false,
        apiContent: null,
        onChoice: choose,
        onStageChange: vi.fn(),
        onPrimaryChange: receive,
      },
    });
    expect(nodes.some((node) => node.type === AgentConnectionPicker)).toBe(
      false,
    );
    expect(button(nodes, R.backMethod)?.props.className).toContain("btn-ghost");
    expect(receive.mock.calls.at(-1)?.[0]).toMatchObject({
      label: R.accountContinue("Account"),
      disabled: false,
    });
    expect(beginAuthentication).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
  },
);

it.each(["agent", "terminal", "api-key"] as const)(
  "commits the default %s choice before opening its account form",
  async (kind) => {
    h.methods.mockResolvedValue({
      methods: [
        {
          id: "default",
          kind,
          name: "Default account",
          ...(kind === "api-key" ? { apiKeyProvider: "openai" } : {}),
        },
      ],
      canLogout: false,
    });
    let methodId: string | null = null;
    let choice: "existing" | "login" | "api" = "existing";
    let stage: "method" | "account" | "api" = "method";
    const receive = vi.fn();
    const choose = vi.fn((value: typeof choice, id?: string) => {
      choice = value;
      methodId = id ?? null;
      stage = "method";
    });
    const advance = vi.fn((value: typeof stage) => {
      stage = value;
    });
    const props = (): Partial<AgentAuthSectionProps> => ({
      methodId,
      connection: {
        choice,
        stage,
        apiAvailable: false,
        apiContent: null,
        onChoice: choose,
        onStageChange: advance,
        onPrimaryChange: receive,
      },
    });
    const initial = await settled(undefined, {
      ...props(),
      apiState: "unsupported",
    });
    expect(
      initial.find((node) => node.type === AgentConnectionPicker)?.props
        .options,
    ).toHaveLength(1);
    expect(initial.some((node) => node.type === MethodApiKeySection)).toBe(
      false,
    );
    expect(initial.some((node) => node.props.children === R.choose)).toBe(true);
    expect(choose).not.toHaveBeenCalled();
    const primary = receive.mock.calls.at(-1)?.[0];
    expect(primary?.disabled).toBe(false);
    primary.run();
    expect(choose).toHaveBeenCalledExactlyOnceWith("login", "default");
    expect(choose.mock.invocationCallOrder[0]).toBeLessThan(
      advance.mock.invocationCallOrder[0],
    );
    expect(methodId).toBe("default");
    expect(stage).toBe("account");
    const nodes = await settled(undefined, props());
    expect(nodes.some((node) => node.type === AgentConnectionPicker)).toBe(
      false,
    );
    expect(button(nodes, R.backMethod)?.props.className).toContain("btn-ghost");
    expect(nodes.some((node) => node.props.children === R.existingStatus)).toBe(
      false,
    );
    expect(beginAuthentication).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    if (kind === "terminal") {
      const next = receive.mock.calls.at(-1)?.[0];
      expect(next?.label).toBe(R.terminalStart);
      next.run();
      expect(beginAuthentication).toHaveBeenCalledOnce();
    }
  },
);

it("keeps a restored existing-settings summary separate from login choices", async () => {
  h.methods.mockResolvedValue({
    methods: [{ id: "account", kind: "agent", name: "Account" }],
    canLogout: false,
  });
  const receive = vi.fn();
  const nodes = await settled(undefined, {
    connection: {
      choice: "existing",
      stage: "account",
      apiAvailable: false,
      apiContent: null,
      onChoice: vi.fn(),
      onStageChange: vi.fn(),
      onPrimaryChange: receive,
    },
  });
  expect(nodes.some((node) => node.type === AgentConnectionPicker)).toBe(false);
  expect(
    nodes.some(
      (node) =>
        node.type === ConnectionAccount && node.props.agentId === agentId,
    ),
  ).toBe(true);
  expect(receive.mock.calls.at(-1)?.[0] ?? null).toBeNull();
  expect(beginAuthentication).not.toHaveBeenCalled();
});

it("offers a saved-settings finish for an exit-code login, then waits for explicit confirmation and a real connection check", async () => {
  const job = authenticationActivity(agentId),
    exit = deferred<number>(),
    close = deferred<number | null>(),
    checked = deferred<void>();
  const terminate = vi.fn(() => close.promise);
  job.begin(
    { agentId, cwd: "/original" },
    {
      kind: "authentication",
      methodId: "login",
      title: "Login",
      completion: "exit_code",
    },
    "attempt",
  );
  job.terminal({
    start: async () => "owned",
    wait: () => exit.promise,
    close: terminate,
    reconnect: () => checked.promise,
  });
  let nodes = await settled();
  const request = button(nodes, "已保存设置，结束终端并检查连接");
  expect(request).toBeDefined();
  expect(request.props.disabled).toBe(false);
  expect(
    nodes.some(
      (node) =>
        node.props.children ===
        "请只在终端完成账号或服务设置。确认已保存后，可结束仍在运行的终端并检查连接；不会自动确认登录或模型可用。",
    ),
  ).toBe(true);
  (request.props.onClick as () => void)();
  nodes = await settled();
  expect(terminate).not.toHaveBeenCalled();
  expect(job.getSnapshot()?.phase).toBe("waiting");
  const confirm = button(nodes, "确认已保存，结束终端并检查连接");
  expect(confirm).toBeDefined();
  (confirm.props.onClick as () => void)();
  await Promise.resolve();
  expect(terminate).toHaveBeenCalledOnce();
  expect(job.getSnapshot()?.phase).toBe("cancelling");
  expect(button(await settled(), "继续选择模型")).toBeUndefined();
  close.resolve(130);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("checking"));
  nodes = await settled();
  expect(
    nodes.some(
      (node) =>
        node.props.children ===
        "终端已结束，正在检查连接；账号设置是否已保存仍由你确认。",
    ),
  ).toBe(true);
  checked.resolve();
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("completed"));
  nodes = await settled();
  expect(job.getSnapshot()).toMatchObject({
    checked: true,
    operationConfirmed: false,
  });
  expect(nodes.some((node) => node.props.children === A.cancelled)).toBe(false);
  expect(nodes.some((node) => node.props.children === R.terminalChecked)).toBe(
    true,
  );
  (button(nodes, "继续选择模型").props.onClick as () => void)();
  expect(h.openModels).toHaveBeenCalledOnce();
  exit.resolve(130);
});

it("disables finish before a terminal id exists and rechecks late work and attempt identity before confirmation", async () => {
  const job = authenticationActivity(agentId),
    ready = deferred<string>(),
    exit = deferred<number>();
  const close = vi.fn(async () => 130);
  job.begin(
    { agentId, cwd: "/original" },
    {
      kind: "authentication",
      methodId: "login",
      title: "Login",
      completion: "exit_code",
    },
    "attempt",
  );
  job.terminal({
    start: () => ready.promise,
    wait: () => exit.promise,
    close,
    reconnect: h.changed,
  });
  let nodes = await settled();
  const early = button(nodes, "已保存设置，结束终端并检查连接");
  expect(early).toBeDefined();
  expect(early.props.disabled).toBe(true);
  (early.props.onClick as () => void)();
  expect(close).not.toHaveBeenCalled();
  ready.resolve("owned");
  await job.getSnapshot()!.terminal!.start();
  nodes = await settled();
  (
    button(nodes, "已保存设置，结束终端并检查连接").props.onClick as () => void
  )();
  nodes = await settled();
  const confirm = button(nodes, "确认已保存，结束终端并检查连接");
  const work = freshThreadState("late-work", agentId, "/original", "work");
  work.running = true;
  h.threads.set(work.key, work);
  (confirm.props.onClick as () => void)();
  expect(close).not.toHaveBeenCalled();
  expect(
    button(await settled(), "确认已保存，结束终端并检查连接").props.disabled,
  ).toBe(true);
  h.threads.clear();
  exit.resolve(0);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("completed"));
  job.begin(
    { agentId, cwd: "/original" },
    {
      kind: "authentication",
      methodId: "later",
      title: "Later",
      completion: "exit_code",
    },
    "later",
  );
  (confirm.props.onClick as () => void)();
  expect(close).not.toHaveBeenCalled();
});

it.each([
  "different-directory",
  "different-source",
  "navigation-blocked",
  "late-work",
  "logout",
])(
  "cannot open models from a completed account action with %s",
  async (cause) => {
    const job = authenticationActivity(agentId);
    job.begin(
      { agentId, cwd: "/original" },
      {
        kind: "authentication",
        methodId: "login",
        title: "Login",
        completion: "exit_code",
        intent: cause === "logout" ? "logout" : "login",
      },
      "attempt",
    );
    await job.protocol({
      run: async () => {},
      cancel: async () => {},
      reconnect: h.changed,
    });
    const props = {
      cwd: cause === "different-directory" ? "/elsewhere" : "/original",
      canOpenModels: true,
    };
    let nodes = await settled(
      cause === "different-source" ? "api-context" : undefined,
      props,
    );
    const models = button(nodes, "继续选择模型");
    if (cause === "navigation-blocked") {
      expect(models).toBeDefined();
      nodes = await settled(undefined, { ...props, canOpenModels: false });
      expect(button(nodes, "继续选择模型").props.disabled).toBe(true);
      (models.props.onClick as () => void)();
    } else if (cause === "late-work") {
      expect(models).toBeDefined();
      const work = freshThreadState("work", agentId, "/elsewhere", "work");
      work.running = true;
      h.threads.set(work.key, work);
      (models.props.onClick as () => void)();
      nodes = await settled(undefined, props);
      expect(button(nodes, "继续选择模型").props.disabled).toBe(true);
    } else {
      expect(!models || models.props.disabled).toBe(true);
      if (models) (models.props.onClick as () => void)();
    }
    expect(h.openModels).not.toHaveBeenCalled();
  },
);
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});

it.each([undefined, "login"] as const)(
  "shows the actual protocol login receipt for intent %s before and after its independent connection check",
  async (intent) => {
    const job = authenticationActivity(agentId),
      response = deferred<void>(),
      check = deferred<void>();
    job.begin({ agentId, cwd: "/original" }, { ...login, intent }, "receipt");
    const run = job.protocol({
      run: () => response.promise,
      cancel: async () => {},
      reconnect: () => check.promise,
    });
    let nodes = await settled();
    expect(loginSuccess(nodes)).toBe(false);
    expect(
      nodes.some(
        (node) => node.props.children === "等待授权，请按 Agent 的提示完成登录",
      ),
    ).toBe(true);
    response.resolve();
    nodes = await settled();
    expect(job.getSnapshot()).toMatchObject({
      phase: "checking",
      operationConfirmed: true,
      checked: false,
    });
    expect(
      nodes.some((node) => node.props.children === A.loginConfirmedChecking),
    ).toBe(true);
    check.resolve();
    await run;
    nodes = await settled();
    expect(nodes.some((node) => node.props.children === R.confirmed)).toBe(
      true,
    );
  },
);

it("retains a confirmed login when the connection check fails and replaces only the check result on retry", async () => {
  const job = authenticationActivity(agentId);
  job.begin({ agentId, cwd: "/original" }, login, "receipt");
  await job.protocol({
    run: async () => {},
    cancel: async () => {},
    reconnect: async () => {
      throw new Error("check failed");
    },
  });
  let nodes = await settled();
  expect(job.getSnapshot()).toMatchObject({
    operationConfirmed: true,
    checked: false,
  });
  expect(
    nodes.some((node) => node.props.children === A.loginConfirmedCheckFailed),
  ).toBe(true);
  await (button(nodes, R.connection).props.onClick as () => Promise<void>)();
  nodes = await settled();
  expect(nodes.some((node) => node.props.children === R.confirmed)).toBe(true);
});

it.each(["connection-only", "terminal-zero"])(
  "does not manufacture a protocol login receipt from %s",
  async (route) => {
    const job = authenticationActivity(agentId);
    job.begin({ agentId, cwd: "/original" }, login, "check");
    if (route === "connection-only") {
      await job.protocol({
        run: async () => {
          throw new Error("AUTH_CANCELLED");
        },
        cancel: async () => {},
        reconnect: h.changed,
      });
      const check = deferred<void>();
      const recheck = job.recheck(() => check.promise);
      const nodes = await settled();
      expect(
        nodes.some((node) => node.props.children === A.accountChecking),
      ).toBe(true);
      expect(loginSuccess(nodes)).toBe(false);
      check.resolve();
      await recheck;
    } else {
      job.terminal({
        start: async () => "terminal",
        wait: async () => 0,
        close: async () => 0,
        reconnect: h.changed,
      });
      await vi.waitFor(() =>
        expect(job.getSnapshot()?.phase).toBe("completed"),
      );
    }
    expect(job.getSnapshot()?.checked).toBe(true);
    expect(loginSuccess(await settled())).toBe(false);
  },
);

it("shows unknown and failed authentication without success, then clears a prior receipt on a new login attempt", async () => {
  const job = authenticationActivity(agentId),
    response = deferred<void>();
  job.begin({ agentId, cwd: "/original" }, login, "unknown");
  const pending = job.protocol({
    run: (unknown) => {
      unknown();
      return response.promise;
    },
    cancel: async () => {},
    reconnect: h.changed,
  });
  let nodes = await settled();
  expect(nodes.some((node) => node.props.children === A.unknown)).toBe(true);
  expect(loginSuccess(nodes)).toBe(false);
  response.reject(new Error("authentication denied"));
  await pending;
  expect(loginSuccess(await settled())).toBe(false);
  job.begin({ agentId, cwd: "/original" }, login, "retry");
  await job.protocol({
    run: async () => {},
    cancel: async () => {},
    reconnect: h.changed,
  });
  expect(loginSuccess(await settled())).toBe(true);
  job.begin({ agentId, cwd: "/original" }, login, "new");
  expect(loginSuccess(await settled())).toBe(false);
});

it.each([
  "other-directory",
  "other-source",
  "logout",
  "switch_account",
  "configuration",
])("does not present the current login as confirmed for %s", async (cause) => {
  const job = authenticationActivity(agentId);
  job.begin(
    { agentId, cwd: "/original" },
    cause === "configuration"
      ? {
          kind: "preparation",
          actionId: "settings",
          title: "Settings",
          purpose: "service_configuration",
          completion: "exit_code",
        }
      : {
          ...login,
          intent:
            cause === "logout" || cause === "switch_account" ? cause : "login",
        },
    "receipt",
  );
  await job.protocol({
    run: async () => {},
    cancel: async () => {},
    reconnect: h.changed,
  });
  const nodes = await settled(
    cause === "other-source" ? "api-context" : undefined,
    { cwd: cause === "other-directory" ? "/elsewhere" : "/original" },
  );
  expect(job.getSnapshot()?.operationConfirmed).toBe(true);
  expect(loginSuccess(nodes)).toBe(false);
  if (cause === "other-directory" || cause === "other-source")
    expect(nodes.some((node) => node.props.children === A.otherTarget)).toBe(
      false,
    );
});

it("keeps confirmed completion as a summary, then explicitly opens management before another login", async () => {
  h.methods.mockResolvedValue({
    methods: [
      { id: "method", kind: "agent", name: "Account" },
      { id: "other", kind: "agent", name: "Other account" },
      {
        id: "key",
        kind: "api-key",
        name: "Key account",
        apiKeyProvider: "provider",
      },
    ],
    canLogout: false,
  });
  const job = authenticationActivity(agentId);
  job.begin({ agentId, cwd: "/original" }, login, "receipt");
  await job.protocol({
    run: async () => {},
    cancel: async () => {},
    reconnect: h.changed,
  });
  let nodes = await settled(undefined, { methodId: "method" });
  expect(nodes.some((node) => node.type === AgentConnectionPicker)).toBe(false);
  expect(nodes.some((node) => node.props.children === R.confirmed)).toBe(true);
  expect(nodes.some((node) => node.type === MethodApiKeySection)).toBe(false);
  const manage = button(nodes, A.loginAgain);
  expect(manage).toBeDefined();
  (manage.props.onClick as () => void)();
  expect(beginAuthentication).not.toHaveBeenCalled();
  nodes = await settled(undefined, { methodId: "method" });
  (button(nodes, A.loginAgain).props.onClick as () => void)();
  expect(beginAuthentication).toHaveBeenCalledOnce();
  // This test isolates the UI from the launch implementation. Open management
  // again before choosing another route; the completed receipt still exists.
  nodes = await settled(undefined, { methodId: "method" });
  (button(nodes, R.change).props.onClick as () => void)();
  nodes = await settled(undefined, { methodId: "other" });
  expect(button(nodes, R.continue)).toBeDefined();
  expect(button(nodes, R.accountContinue("Other account"))).toBeUndefined();
  expect(button(nodes, A.loginAgain)).toBeUndefined();
  nodes = await settled(undefined, { methodId: "key" });
  (button(nodes, R.continue).props.onClick as () => void)();
  nodes = await settled(undefined, { methodId: "key" });
  expect(
    nodes.find((node) => node.type === MethodApiKeySection)?.props.startLabel,
  ).toBe(R.verifyConnect);
  job.begin(
    { agentId, cwd: "/original" },
    { ...login, methodId: "key" },
    "key-receipt",
  );
  await job.protocol({
    run: async () => {},
    cancel: async () => {},
    reconnect: h.changed,
  });
  // Return to the summary before asking to manage this key.
  h.slots = [];
  h.effects = [];
  h.pending = [];
  nodes = await settled(undefined, { methodId: "key" });
  expect(nodes.some((node) => node.props.children === R.keyConfirmed)).toBe(
    true,
  );
  expect(nodes.some((node) => node.type === MethodApiKeySection)).toBe(false);
  (button(nodes, R.keyManage).props.onClick as () => void)();
  nodes = await settled(undefined, { methodId: "key" });
  expect(
    nodes.find((node) => node.type === MethodApiKeySection)?.props.startLabel,
  ).toBe(R.keyVerify);
});

it("revokes an inline finish confirmation when the visible target changes or the user chooses to keep working", async () => {
  const job = authenticationActivity(agentId),
    exit = deferred<number>();
  const close = vi.fn(async () => 130);
  job.begin(
    { agentId, cwd: "/original" },
    {
      kind: "authentication",
      methodId: "login",
      title: "Login",
      completion: "exit_code",
    },
    "attempt",
  );
  job.terminal({
    start: async () => "owned",
    wait: () => exit.promise,
    close,
    reconnect: h.changed,
  });
  let nodes = await settled();
  (button(nodes, A.finish).props.onClick as () => void)();
  nodes = await settled();
  const previous = button(nodes, A.finishConfirm);
  (button(nodes, A.finishBack).props.onClick as () => void)();
  (previous.props.onClick as () => void)();
  expect(close).not.toHaveBeenCalled();
  nodes = await settled();
  (button(nodes, A.finish).props.onClick as () => void)();
  nodes = await settled();
  const original = button(nodes, A.finishConfirm);
  nodes = await settled(undefined, { cwd: "/elsewhere" });
  expect(button(nodes, A.finishConfirm)).toBeUndefined();
  (original.props.onClick as () => void)();
  expect(close).not.toHaveBeenCalled();
  await settled();
  (original.props.onClick as () => void)();
  expect(close).not.toHaveBeenCalled();
  await job.cancel();
  exit.resolve(130);
});

it("starts the reviewed configuration at its confirmed location rather than its display alias", async () => {
  const nodes = await settled();
  const actions = nodes.find((node) => node.type === AgentPreparationActions)!;
  (actions.props.onRun as (action: unknown, cwd: string) => void)(
    { id: "configure" },
    "/canonical-original",
  );
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { agentId, cwd: "/canonical-original", source: undefined },
    }),
  );
});

it.each(["directory", "source"])(
  "rejects the old preparation callback after its visible %s changes before effect cleanup with no method table",
  async (cause) => {
    const nodes = await settled();
    expect(nodes.some((node) => node.type === AgentConnectionPicker)).toBe(
      false,
    );
    const old = nodes.find((node) => node.type === AgentPreparationActions)!
      .props.onRun as (action: unknown, cwd: string) => void;
    render(
      cause === "source" ? "new-api-context" : undefined,
      { cwd: cause === "directory" ? "/new-directory" : "/original" },
      false,
    );
    old({ id: "configure" }, "/canonical-original");
    expect(h.prepare).not.toHaveBeenCalled();
  },
);

it("returns from official terminal review to the shared method list without discarding the chosen action", async () => {
  h.methods.mockResolvedValue({
    methods: [{ id: "account", kind: "agent", name: "Account" }],
    canLogout: false,
  });
  const action = {
    id: "configure",
    purpose: "service_configuration",
    transport: "terminal",
    command: "/managed/example",
    args: ["configure"],
    sourceUrl: "https://example.com/official",
  };
  h.preparation.mockResolvedValue({ actions: [action] });
  const changeStage = vi.fn(),
    choose = vi.fn(),
    receive = vi.fn();
  const connection: NonNullable<AgentAuthSectionProps["connection"]> = {
    choice: "existing",
    stage: "method",
    apiAvailable: false,
    apiContent: null,
    onChoice: choose,
    onStageChange: changeStage,
    onPrimaryChange: receive,
  };
  let nodes = await settled(undefined, { connection });
  const picker = nodes.find((node) => node.type === AgentConnectionPicker)!;
  (picker.props.onChange as (id: string) => void)(
    JSON.stringify(["action", action.id]),
  );
  expect(choose).toHaveBeenCalledExactlyOnceWith(
    "existing",
    undefined,
    action.id,
  );
  expect(changeStage).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
  connection.actionId = action.id;
  nodes = await settled(undefined, { connection });
  const continueReview = receive.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  expect(continueReview).toMatchObject({
    label: R.continue,
    disabled: false,
  });
  continueReview.run();
  expect(changeStage).toHaveBeenCalledExactlyOnceWith("account");
  expect(h.prepare).not.toHaveBeenCalled();
  connection.stage = "account";
  nodes = await settled(undefined, { connection });
  expect(nodes.some((node) => node.type === AgentConnectionPicker)).toBe(false);
  const review = nodes.find((node) => node.type === AgentPreparationActions)!;
  expect(review.props).toMatchObject({
    selectedId: action.id,
    hideChoices: true,
    reviewSelected: true,
  });
  expect(review.props.onCancelReview).toBeTypeOf("function");
  (review.props.onCancelReview as () => void)();
  expect(changeStage).toHaveBeenNthCalledWith(2, "method");
  expect(choose).toHaveBeenCalledOnce();
  nodes = await settled(undefined, {
    connection: { ...connection, stage: "method" },
  });
  expect(
    nodes.find((node) => node.type === AgentConnectionPicker)?.props.value,
  ).toBe(JSON.stringify(["action", action.id]));
  const footer = receive.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  expect(footer).toMatchObject({ label: R.continue, disabled: false });
  expect(h.prepare).not.toHaveBeenCalled();
});

it("keeps an old result internal when viewing a different source and checks only the current source", async () => {
  const job = authenticationActivity(agentId);
  job.begin(
    { agentId, cwd: "/original" },
    {
      kind: "preparation",
      actionId: "configure",
      purpose: "service_configuration",
      title: S.title,
      completion: "exit_code",
    },
    "attempt",
  );
  job.terminal({
    start: async () => "terminal",
    wait: async () => 1,
    close: async () => 1,
    reconnect: h.changed,
  });
  const nodes = await settled("api-context");
  expect(nodes.some((node) => node.props.children === S.exitFailed(1))).toBe(
    false,
  );
  const actions = nodes.find((node) => node.type === AgentPreparationActions)!;
  expect(actions.props.source).toBe("api-context");
  (actions.props.onRun as (value: unknown) => void)({ id: "configure" });
  expect(h.prepare).not.toHaveBeenCalled();
  await (button(nodes, R.connection).props.onClick as () => Promise<void>)();
  expect(h.recheck).not.toHaveBeenCalled();
  expect(job.getSnapshot()?.terminalOutcome).toMatchObject({
    kind: "ended",
    code: 1,
  });
});

it("keeps the ended command, original terminal and failed check visible when methods disappear", async () => {
  const job = authenticationActivity(agentId),
    exit = deferred<number>();
  job.begin(
    { agentId, cwd: "/original" },
    {
      kind: "preparation",
      actionId: "configure",
      purpose: "service_configuration",
      title: S.title,
      completion: "exit_code",
    },
    "attempt",
  );
  job.terminal({
    start: async () => "terminal",
    wait: () => exit.promise,
    close: async () => 1,
    reconnect: async () => {
      throw new Error("connection failed");
    },
  });
  await settled();
  exit.resolve(0);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("completed"));
  h.methods.mockRejectedValue(new Error("methods unavailable"));
  // Remount the view with no retained method table or component state.
  for (const effect of h.effects) effect?.cleanup?.();
  h.slots = [];
  h.effects = [];
  let nodes = await settled();
  expect(nodes.some((node) => node.props.children === S.title)).toBe(true);
  expect(nodes.some((node) => node.props.children === S.ended)).toBe(true);
  expect(nodes.some((node) => node.props.role === "alert")).toBe(true);
  expect(
    nodes.find((node) => node.type === InlineTerminal)?.props,
  ).toMatchObject({
    session: job.getSnapshot()!.terminal,
    purpose: "service_configuration",
  });
  expect(nodes.some((node) => node.type === AgentPreparationActions)).toBe(
    true,
  );
  expect(button(nodes, R.connection).props.disabled).toBe(false);
  await (button(nodes, R.connection).props.onClick as () => Promise<void>)();
  nodes = await settled();
  expect(h.recheck).toHaveBeenCalledWith(
    { agentId, cwd: "/original" },
    h.changed,
  );
  expect(job.getSnapshot()).toMatchObject({
    phase: "completed",
    checked: true,
    error: null,
  });
  expect(nodes.some((node) => node.props.children === S.ended)).toBe(false);
  expect(nodes.some((node) => node.type === InlineTerminal)).toBe(false);
  expect(job.getSnapshot()?.terminalOutcome).toMatchObject({
    kind: "ended",
    code: 0,
  });
  expect(nodes.some((node) => node.props.children === R.terminalChecked)).toBe(
    true,
  );
});

it.each([1, 130])(
  "retains a nonzero or cancelled terminal exit %i with an explicit recheck",
  async (code) => {
    const job = authenticationActivity(agentId),
      exit = deferred<number>();
    job.begin(
      { agentId, cwd: "/original" },
      {
        kind: "preparation",
        actionId: "configure",
        purpose: "service_configuration",
        title: S.title,
        completion: "exit_code",
      },
      "attempt",
    );
    job.terminal({
      start: async () => "terminal",
      wait: () => exit.promise,
      close: async () => code,
      reconnect: h.changed,
    });
    if (code === 130) await job.cancel();
    else exit.resolve(code);
    let nodes = await settled();
    expect(job.getSnapshot()?.phase).toBe(
      code === 130 ? "cancelled" : "failed",
    );
    expect(button(nodes, R.connection).props.disabled).toBe(false);
    expect(h.changed).not.toHaveBeenCalled();
    expect(nodes.some((node) => node.props.children === S.ended)).toBe(false);
    expect(
      nodes.filter(
        (node) =>
          node.props.children ===
          (code === 130 ? S.cancelled : S.exitFailed(code)),
      ),
    ).toHaveLength(1);
    await (button(nodes, R.connection).props.onClick as () => Promise<void>)();
    nodes = await settled();
    expect(job.getSnapshot()?.checked).toBe(true);
    expect(nodes.some((node) => node.type === InlineTerminal)).toBe(true);
    expect(
      nodes.some(
        (node) =>
          node.props.children ===
          (code === 130 ? S.cancelled : S.exitFailed(code)),
      ),
    ).toBe(true);
    exit.resolve(code);
  },
);

it("keeps the original operation and terminal finish outlet even when the latest method table is empty", async () => {
  const job = authenticationActivity(agentId),
    exit = deferred<number>();
  const operation = {
    kind: "authentication" as const,
    methodId: "method",
    title: "Original setup",
    completion: "return_and_verify" as const,
  };
  job.begin({ agentId, cwd: "/original" }, operation, "attempt");
  job.terminal({
    start: async () => "terminal",
    wait: () => exit.promise,
    close: async () => 1,
    reconnect: h.changed,
  });
  operation.title = "changed";
  const nodes = await settled();
  expect(nodes.some((node) => node.props.children === "Original setup")).toBe(
    true,
  );
  expect(button(nodes, A.finish)).toBeDefined();
  await job.cancel();
  exit.resolve(1);
});

const terminalOperations = [
  {
    kind: "authentication" as const,
    methodId: "method",
    title: "Original login",
    completion: "exit_code" as const,
  },
  {
    kind: "preparation" as const,
    actionId: "configure",
    purpose: "service_configuration" as const,
    title: S.title,
    completion: "exit_code" as const,
  },
];

it.each(
  terminalOperations.flatMap((operation) =>
    ["cancelled", "failed", "completed"].map((outcome) => ({
      operation,
      outcome,
    })),
  ),
)(
  "opens the original $operation.kind terminal record after $outcome without restarting",
  async ({ operation, outcome }) => {
    const job = authenticationActivity(agentId);
    const exit = deferred<number>();
    const checked = deferred<void>();
    const start = vi.fn(async (output: (value: string) => void) => {
      output("retained terminal output");
      return "original-terminal";
    });
    const close = vi.fn(async () => 130);
    const reconnect = vi.fn(async () => {
      await checked.promise;
      if (outcome === "failed") throw new Error("recheck failed");
    });
    job.begin({ agentId, cwd: "/original" }, operation, "attempt");
    job.terminal({ start, wait: () => exit.promise, close, reconnect });
    let nodes = await settled();
    const terminal = job.getSnapshot()!.terminal;
    (button(nodes, A.hide).props.onClick as () => void)();
    nodes = await settled();
    const runningLabel = operation.kind === "preparation" ? S.show : A.show;
    expect(button(nodes, runningLabel)).toBeDefined();
    expect(nodes.some((node) => node.type === InlineTerminal)).toBe(false);

    if (outcome === "cancelled") await job.cancel();
    else exit.resolve(outcome === "failed" ? 1 : 0);
    nodes = await settled();
    expect(job.getSnapshot()?.phase).toBe(
      outcome === "completed" ? "checking" : outcome,
    );
    expect(button(nodes, "查看终端记录")).toBeDefined();
    expect(button(nodes, runningLabel)).toBeUndefined();
    const ended = job.getSnapshot()!.terminalOutcome;
    (button(nodes, "查看终端记录").props.onClick as () => void)();
    nodes = await settled();
    expect(
      nodes.find((node) => node.type === InlineTerminal)?.props.session,
    ).toBe(terminal);
    expect(terminal?.getSnapshot().output.map((item) => item.data)).toEqual([
      "retained terminal output",
    ]);
    expect(job.getSnapshot()?.terminalOutcome).toBe(ended);
    expect(reconnect).toHaveBeenCalledTimes(outcome === "completed" ? 1 : 0);
    (button(nodes, A.hide).props.onClick as () => void)();

    // Rechecking is active account work, but the terminal has already ended.
    if (outcome !== "completed") void job.recheck(reconnect);
    nodes = await settled();
    expect(job.getSnapshot()?.phase).toBe("checking");
    expect(button(nodes, "查看终端记录")).toBeDefined();
    checked.resolve();
    nodes = await settled();
    expect(job.getSnapshot()?.checked).toBe(outcome !== "failed");
    if (outcome !== "completed")
      expect(button(nodes, "查看终端记录")).toBeDefined();
    else {
      expect(button(nodes, "查看终端记录")).toBeUndefined();
      expect(
        nodes.some((node) => node.props.children === R.terminalChecked),
      ).toBe(true);
    }
    expect(terminal?.getSnapshot().output.map((item) => item.data)).toEqual([
      "retained terminal output",
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(outcome === "cancelled" ? 1 : 0);
    expect(beginAuthentication).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    exit.resolve(130);
  },
);

it.each(
  terminalOperations.flatMap((operation) =>
    ["cancelled", "failed"].map((outcome) => ({ operation, outcome })),
  ),
)(
  "keeps $operation.kind startup $outcome output as a record without retrying",
  async ({ operation, outcome }) => {
    const job = authenticationActivity(agentId);
    const start = vi.fn(async (output: (value: string) => void) => {
      output("startup output");
      throw new Error(
        outcome === "cancelled" ? "AUTH_CANCELLED" : "start failed",
      );
    });
    const wait = vi.fn(async () => 0);
    job.begin({ agentId, cwd: "/original" }, operation, "attempt");
    job.terminal({ start, wait, close: async () => 1, reconnect: h.changed });
    let nodes = await settled();
    expect(job.getSnapshot()?.terminalOutcome?.kind).toBe(outcome);
    const terminal = job.getSnapshot()!.terminal;
    (button(nodes, A.hide).props.onClick as () => void)();
    nodes = await settled();
    expect(button(nodes, "查看终端记录")).toBeDefined();
    (button(nodes, "查看终端记录").props.onClick as () => void)();
    nodes = await settled();
    expect(
      nodes.find((node) => node.type === InlineTerminal)?.props.session,
    ).toBe(terminal);
    expect(terminal?.getSnapshot().output.map((item) => item.data)).toEqual([
      "startup output",
    ]);
    expect(job.getSnapshot()?.terminalOutcome?.kind).toBe(outcome);
    expect(start).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
    expect(beginAuthentication).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  },
);

it.each(terminalOperations)(
  "does not label an unconfirmed $kind terminal close as an ended record",
  async (operation) => {
    const job = authenticationActivity(agentId);
    const exit = deferred<number>();
    const start = vi.fn(async () => "original-terminal");
    job.begin({ agentId, cwd: "/original" }, operation, "attempt");
    job.terminal({
      start,
      wait: () => exit.promise,
      close: async () => {
        throw new Error("close unconfirmed");
      },
      reconnect: h.changed,
    });
    let nodes = await settled();
    (button(nodes, A.hide).props.onClick as () => void)();
    await job.cancel();
    nodes = await settled();
    expect(job.getSnapshot()).toMatchObject({
      phase: "unknown",
      terminalOutcome: null,
    });
    const runningLabel = operation.kind === "preparation" ? S.show : A.show;
    expect(button(nodes, runningLabel)).toBeDefined();
    expect(button(nodes, "查看终端记录")).toBeUndefined();
    (button(nodes, runningLabel).props.onClick as () => void)();
    nodes = await settled();
    expect(
      nodes.find((node) => node.type === InlineTerminal)?.props.session,
    ).toBe(job.getSnapshot()!.terminal);
    expect(start).toHaveBeenCalledTimes(1);
    exit.resolve(130);
    await settled();
  },
);

it.each(
  (["logout", "switch_account"] as const).flatMap((intent) =>
    [false, true].map((connectedView) => ({ intent, connectedView })),
  ),
)(
  "does not turn a connection check after failed $intent into a confirmed account exit (connected view $connectedView)",
  async ({ intent, connectedView }) => {
    const job = authenticationActivity(agentId);
    job.begin(
      { agentId, cwd: "/original" },
      {
        kind: "authentication",
        methodId: "logout",
        title: A.switchAccount,
        intent,
        completion: "exit_code",
      },
      "exit-attempt",
    );
    await job.protocol({
      run: async () => {
        throw new Error("账号退出尚未确认");
      },
      cancel: async () => {},
      reconnect: h.changed,
    });
    await job.recheck(h.changed);
    const nodes = await settled(
      undefined,
      connectedView
        ? {
            connection: {
              choice: "login",
              stage: "method",
              apiAvailable: false,
              apiContent: null,
              onChoice: vi.fn(),
              onStageChange: vi.fn(),
            },
          }
        : {},
    );
    expect(
      nodes.some((node) => node.props.children === A.logoutNotConfirmed),
    ).toBe(true);
    expect(nodes.some((node) => node.props.children === A.logoutChecked)).toBe(
      false,
    );
    expect(nodes.some((node) => node.props.children === A.switchReady)).toBe(
      false,
    );
    expect(beginAuthentication).not.toHaveBeenCalled();
  },
);

it.each(["api", "other-method"])(
  "keeps a successful old account receipt internal on %s detail",
  async (route) => {
    h.methods.mockResolvedValue({
      methods: [
        { id: "method", kind: "agent", name: "ChatGPT" },
        { id: "other", kind: "agent", name: "Other account" },
      ],
      canLogout: false,
    });
    const activity = authenticationActivity(agentId);
    activity.begin(
      { agentId, cwd: "/original" },
      { ...login, title: "ChatGPT" },
      "confirmed-login",
    );
    await activity.protocol({
      run: async () => {},
      cancel: async () => {},
      reconnect: h.changed,
    });
    const receive = vi.fn();
    const nodes = await settled(undefined, {
      methodId: route === "api" ? null : "other",
      connection: {
        choice: route === "api" ? "api" : "login",
        stage: route === "api" ? "api" : "account",
        apiAvailable: true,
        apiContent: <div>Service selection</div>,
        onChoice: vi.fn(),
        onStageChange: vi.fn(),
        onPrimaryChange: receive,
      },
    });
    expect(loginSuccess(nodes)).toBe(false);
    expect(nodes.some((node) => node.props.children === "ChatGPT")).toBe(false);
    expect(nodes.some((node) => node.props.title === "/original")).toBe(false);
    expect(nodes.some((node) => node.type === AgentConnectionPicker)).toBe(
      false,
    );
    expect(button(nodes, R.backMethod)?.props.className).toContain("btn-ghost");
    expect(activity.getSnapshot()).toMatchObject({
      operationConfirmed: true,
      checked: true,
    });
    if (route === "api")
      expect(receive.mock.calls.at(-1)?.[0] ?? null).toBeNull();
    expect(beginAuthentication).not.toHaveBeenCalled();
  },
);

it.each([null, "removed"])(
  "returns an unresolved saved login method %s to the choice page",
  async (methodId) => {
    h.methods.mockResolvedValue({
      methods: [{ id: "available", name: "Account", kind: "agent" }],
      canLogout: false,
    });
    const receive = vi.fn();
    const nodes = await settled(undefined, {
      methodId,
      apiState: "unsupported",
      connection: {
        choice: "login",
        stage: "account",
        apiAvailable: false,
        apiContent: null,
        onChoice: vi.fn(),
        onStageChange: vi.fn(),
        onPrimaryChange: receive,
      },
    });
    expect(
      nodes.find((node) => node.type === AgentConnectionPicker)?.props.options,
    ).toHaveLength(1);
    expect(receive.mock.calls.at(-1)?.[0]?.label).toBe(R.continue);
    expect(beginAuthentication).not.toHaveBeenCalled();
  },
);

it("rejects a detached key detail callback after returning to the method page", async () => {
  h.methods.mockResolvedValue({
    methods: [
      {
        id: "key",
        kind: "api-key",
        name: "Provider",
        apiKeyProvider: "provider",
      },
    ],
    canLogout: false,
  });
  const connection: NonNullable<AgentAuthSectionProps["connection"]> = {
    choice: "login",
    stage: "account",
    apiAvailable: false,
    apiContent: null,
    onChoice: vi.fn(),
    onStageChange: vi.fn(),
  };
  const nodes = await settled(undefined, { methodId: "key", connection });
  const key = nodes.find((node) => node.type === MethodApiKeySection)!;
  await settled(undefined, {
    methodId: "key",
    connection: { ...connection, stage: "method" },
  });
  (key.props.onStart as (value: { id: string; revision: string }) => void)({
    id: "saved",
    revision: "revision",
  });
  expect(beginAuthentication).not.toHaveBeenCalled();
});

it("retains an explicitly chosen action completion after refreshed declarations remove it without offering to restart", async () => {
  const action = {
    id: "configure",
    purpose: "service_configuration",
    transport: "terminal",
    command: "/example",
    args: [],
    sourceUrl: "https://example.com",
  };
  h.preparation.mockResolvedValue({ actions: [action] });
  const receive = vi.fn();
  const connection: NonNullable<AgentAuthSectionProps["connection"]> = {
    choice: "existing",
    stage: "method",
    apiAvailable: false,
    apiContent: null,
    onChoice: vi.fn(),
    onStageChange: vi.fn(),
    onPrimaryChange: receive,
  };
  let nodes = await settled(undefined, { connection, apiState: "unsupported" });
  const picker = nodes.find((node) => node.type === AgentConnectionPicker)!;
  (picker.props.onChange as (value: string) => void)(
    JSON.stringify(["action", action.id]),
  );
  connection.actionId = action.id;
  connection.stage = "account";
  nodes = await settled(undefined, { connection, apiState: "unsupported" });
  const activity = authenticationActivity(agentId);
  h.prepare.mockImplementationOnce(() => {
    activity.begin(
      { agentId, cwd: "/original" },
      {
        kind: "preparation",
        actionId: action.id,
        purpose: "service_configuration",
        title: "Settings",
        completion: "exit_code",
      },
      "chosen-settings",
    );
  });
  (
    nodes.find((node) => node.type === AgentPreparationActions)!.props
      .onRun as (action: unknown, cwd: string) => void
  )(action, "/original");
  await activity.protocol({
    run: async () => {},
    cancel: async () => {},
    reconnect: h.changed,
  });
  h.preparation.mockResolvedValue({ actions: [] });
  nodes = await settled(undefined, { connection, program: "refreshed" });
  expect(nodes.some((node) => node.props.children === R.terminalChecked)).toBe(
    true,
  );
  expect(
    nodes.find((node) => node.type === AgentPreparationActions)?.props
      .reviewSelected,
  ).toBe(false);
  expect(receive.mock.calls.at(-1)?.[0] ?? null).toBeNull();
  expect(h.prepare).toHaveBeenCalledOnce();
});
