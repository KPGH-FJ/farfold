/** Shared synthetic-render harness for the AgentAuthSection suites. Import it
 *  before the components under test so the module mocks register first. */
import { afterEach, beforeEach, vi } from "vitest";
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
export { h };
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
vi.mock("../runtime/connection_account", () => ({
  useConnectionAccount: () => null,
}));
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
import {
  AgentAccountExit,
  AgentAuthManage,
  AgentAuthWorkBlockers,
  AgentExistingVerify,
} from "./AgentAuthManage";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { AUTH_ACTIVITY_STRINGS as A } from "../runtime/auth_strings";

export type Element = ReactElement<Record<string, unknown>>;
let sequence = 0;
export let agentId = "";
export function render(
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
      if (child.type === AgentAuthWorkBlockers)
        visit(
          AgentAuthWorkBlockers(
            child.props as Parameters<typeof AgentAuthWorkBlockers>[0],
          ),
        );
      if (child.type === AgentExistingVerify)
        visit(
          AgentExistingVerify(
            child.props as Parameters<typeof AgentExistingVerify>[0],
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
export async function settled(
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
export const button = (nodes: Element[], label: string) =>
  nodes.find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const login = {
  kind: "authentication" as const,
  methodId: "method",
  title: "Account login",
  completion: "exit_code" as const,
};
export const loginSuccess = (nodes: Element[]) =>
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
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});
