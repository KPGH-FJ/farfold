import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  prepare: vi.fn(),
  start: vi.fn(),
  invalidate: vi.fn(),
  getCapabilities: vi.fn(),
  listCredentials: vi.fn(),
  openApi: vi.fn(),
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
vi.mock("../runtime/agent_preparation", async (original) => ({
  ...(await original<typeof import("../runtime/agent_preparation")>()),
  usePreparation: () => ({
    state: {
      phase: "untested",
      input: null,
      threadKey: null,
      config: {},
      prompt: "",
      reply: "",
      error: null,
    },
    controller: {
      canPrepare: () => true,
      verified: () => false,
      invalidate: h.invalidate,
      prepare: h.prepare,
      start: h.start,
    },
  }),
}));
vi.mock("../runtime/sessions", () => ({
  useThread: () => null,
  modelConfigOption: () => undefined,
  threads: { thread: () => null },
}));
vi.mock("../runtime/authentication", () => ({
  useAuthentication: () => new Set(),
  authenticationRequired: () => false,
  useAuthenticationActivity: () => null,
  subscribeAuthenticationChanges: () => () => {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
}));
vi.mock("../runtime/credentials", () => ({
  subscribeCredentialChanges: () => () => {},
  listCredentials: h.listCredentials,
  getServiceCapabilities: h.getCapabilities,
}));
vi.mock("./ProgramManager", () => ({
  useProgramInventory: () => ({}),
  programSummary: () => "ready",
  ProgramManager: () => null,
}));
// Inspect the exact presentation contract consumed by AgentAuthSection. Its
// implementation selects apiSummary when present, otherwise apiContent.
vi.mock("./AgentAuthSection", () => ({ AgentAuthSection: () => null }));

import { AgentSetup, type AgentSetupProgress } from "./AgentSetup";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { AgentServiceSection } from "./AgentServiceSection";
import { ServicePicker } from "./ServicePicker";
import { R5_SERVICE_STRINGS as R } from "../runtime/r5_service_strings";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import type { Credential } from "../runtime/credentials";

const card: AgentCardModel = {
  id: "api-flow-owner",
  name: "Example",
  description: "",
  status: "connected",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: null,
  installable: false,
  registerable: false,
  custom: true,
  handshake: null,
};
const service: Credential = {
  id: "selected-service",
  label: "Selected service",
  provider: "example",
  endpoint: "https://example.test",
  apiType: "responses",
  models: ["model-a", "model-b"],
  revision: "current-revision",
  complete: true,
  deleting: false,
  grants: [],
};
const second = { ...service, id: "second-service", revision: "r2" };
type Element = ReactElement<Record<string, unknown>>;
type Connection = NonNullable<
  ComponentProps<typeof AgentAuthSection>["connection"]
>;
let progress: AgentSetupProgress;
const changed = vi.fn((next: AgentSetupProgress) => {
  progress = next;
});
function elements(root: ReactNode) {
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(root);
  return nodes;
}
function render() {
  h.cursor = 0;
  const nodes = elements(
    AgentSetup({
      card,
      agents: {
        busy: {},
        errors: {},
        installProgress: {},
        refresh: vi.fn(async () => {}),
      } as unknown as AgentsState,
      cwd: "/own",
      progress,
      onProgress: changed,
      onClose() {},
      onStart() {},
      onOpenApi: h.openApi,
    }),
  );
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
const connection = (nodes: Element[]) =>
  nodes.find((node) => node.type === AgentAuthSection)!.props
    .connection as Connection;
function serviceSection(node: ReactNode) {
  expect(isValidElement(node)).toBe(true);
  const element = node as ReactElement<
    ComponentProps<typeof AgentServiceSection>
  >;
  expect(element.type).toBe(AgentServiceSection);
  return elements(AgentServiceSection(element.props));
}
async function settled() {
  render();
  for (let round = 0; round < 6; round++) await Promise.resolve();
  return render();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.prepare.mockReset();
  h.start.mockReset();
  h.invalidate.mockReset();
  h.getCapabilities.mockReset().mockResolvedValue({
    apiTypes: ["responses"],
    validatedApiTypes: ["responses"],
    selectionScope: "connection",
    unavailableReason: null,
  });
  h.listCredentials.mockReset().mockResolvedValue([service, second]);
  h.openApi.mockClear();
  changed.mockClear();
  progress = {
    step: 1,
    choice: "api",
    accessStage: "api",
    selection: { service: null, config: {} },
  };
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
  const prerequisites = render().find(
    (node) => node.type === AgentPrerequisites,
  )!;
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});

it("leaves the API summary absent before a service is selected so the real service picker is reachable", async () => {
  const api = connection(await settled());
  expect(api).toMatchObject({
    choice: "api",
    stage: "api",
    apiAvailable: true,
  });
  expect(api.apiSummary).toBeUndefined();
  expect(
    serviceSection(api.apiContent).some((node) => node.type === ServicePicker),
  ).toBe(true);
  expect(progress.selection).toEqual({ service: null, config: {} });
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});

it("reopens service editing from the actual summary management button while retaining the unconfirmed model intent", async () => {
  const selected = {
    id: service.id,
    revision: service.revision,
    model: "",
  };
  progress = {
    ...progress,
    selection: { service: selected, config: {} },
  };
  const api = connection(await settled());
  const change = serviceSection(api.apiSummary).find(
    (node) => node.type === "button" && node.props.children === R.changeService,
  )!;
  expect(change).toBeDefined();
  expect(change.props.disabled).toBe(false);
  (change.props.onClick as () => void)();
  const editing = connection(render());
  expect(editing).toMatchObject({ choice: "api", stage: "api" });
  expect(editing.apiSummary).toBeUndefined();
  expect(
    serviceSection(editing.apiContent).some(
      (node) => node.type === ServicePicker,
    ),
  ).toBe(true);
  expect(progress.selection).toEqual({ service: selected, config: {} });
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});

it("opens the exact selected second service from its summary without preparing or sending", async () => {
  const selected = {
    id: second.id,
    revision: second.revision,
    model: "model-b",
  };
  progress = { ...progress, selection: { service: selected, config: {} } };
  const api = connection(await settled());
  const edit = serviceSection(api.apiSummary).find(
    (node) => node.type === "button" && node.props.children === R.editService,
  )!;
  (edit.props.onClick as () => void)();
  expect(h.openApi).toHaveBeenCalledWith({
    agentId: card.id,
    id: second.id,
    revision: second.revision,
  });
  expect(progress.selection?.service).toEqual(selected);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});
