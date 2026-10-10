import { NewConversationLocationBar } from "./NewConversationLocationBar";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentSetupSelection } from "./AgentSetup";
import type { ThreadState, ConfigOptionView } from "../runtime/session_types";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  selections: new Map<string, AgentSetupSelection>(),
  open: vi.fn(),
  setConfig: vi.fn(),
  discardDraft: vi.fn(),
  hold: vi.fn(),
  credentials: vi.fn(),
  credentialListeners: new Set<() => void>(),
  live: null as ThreadState | null,
  enabled: false,
  canonical: null as string | null,
  chooseDirectory: vi.fn(),
  portalTargets: [] as unknown[],
}));
vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode, target: unknown) => {
    h.portalTargets.push(target);
    return children;
  },
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: h.chooseDirectory }));
vi.mock("../runtime/connection_hold", () => ({ useConnectionHold: h.hold }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({
    cwd: h.canonical ?? cwd,
    ready: true,
    enabled: () => h.enabled,
  }),
}));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: h.credentials,
  subscribeCredentialChanges: (listener: () => void) => {
    h.credentialListeners.add(listener);
    return () => h.credentialListeners.delete(listener);
  },
}));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: (id: string) =>
      h.selections.has(id) ? structuredClone(h.selections.get(id)) : undefined,
  },
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: (key: string) => (key === h.live?.key ? h.live : null),
  threads: {
    open: h.open,
    setConfig: h.setConfig,
    discardDraft: h.discardDraft,
    thread: (key: string) => (key === h.live?.key ? h.live : null),
  },
}));
vi.mock(
  "../runtime/worktrees",
  () => import("../runtime/worktree_catalogue.test-fixture"),
);
import { EmptyState } from "./EmptyState";
import { Composer } from "./Composer";
import {
  NewConversationAgentDialog,
  NewConversationModelDialog,
} from "./NewConversationPickers";
import { composerDrafts, newConversationChoice } from "../runtime/drafts";
import type { AgentCardModel } from "../runtime/agents";
import { freshThreadState } from "../runtime/session_projection";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { preparationFor } from "../runtime/agent_preparation";
import { observeAuthentication } from "../runtime/authentication";
import {
  allowAutomaticConnection,
  isAutomaticConnectionAllowed,
  pauseAutomaticConnection,
} from "../runtime/connection_intent";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof EmptyState>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child)) {
      result.push(child, ...nodes(child.props.children as ReactNode));
      if (child.type === NewConversationLocationBar)
        result.push(
          ...nodes(
            NewConversationLocationBar(
              child.props as ComponentProps<typeof NewConversationLocationBar>,
            ),
          ),
        );
    }
  });
  return result;
}
function render() {
  for (let pass = 0; pass < 8; pass++) {
    h.cursor = 0;
    const result = nodes(EmptyState(props));
    if (h.effects.length) {
      for (const effect of h.effects.splice(0)) effect();
      continue;
    }
    return result;
  }
  throw new Error("Unexpected render loop");
}
function composer() {
  return render().find((node) => node.type === Composer)!;
}
function picker() {
  const current = render().find(
    (node) => node.type === NewConversationAgentDialog,
  );
  if (current) return current;
  const trigger = nodes(composer().props.controls as ReactNode).find(
    (node) => node.props["aria-label"] === "选择 Agent",
  )!;
  (trigger.props.onClick as () => void)();
  return render().find((node) => node.type === NewConversationAgentDialog)!;
}
function modelPicker() {
  const current = render().find(
    (node) => node.type === NewConversationModelDialog,
  );
  if (current) return current;
  const trigger = nodes(composer().props.controls as ReactNode).find(
    (node) => node.props["aria-label"] === "模型与来源",
  )!;
  (trigger.props.onClick as () => void)();
  return render().find((node) => node.type === NewConversationModelDialog)!;
}
beforeEach(() => {
  allowAutomaticConnection("A");
  allowAutomaticConnection("B");
  h.slots = [];
  h.effects = [];
  h.open.mockReset();
  h.setConfig.mockReset();
  h.discardDraft.mockReset();
  h.hold.mockClear();
  h.credentials.mockReset().mockImplementation(async () =>
    newConversationChoice.service
      ? [
          {
            ...newConversationChoice.service,
            complete: true,
            deleting: false,
            models: [newConversationChoice.service.model],
          },
        ]
      : [],
  );
  h.credentialListeners.clear();
  h.live = null;
  h.portalTargets = [];
  h.enabled = false;
  h.canonical = null;
  h.selections.clear();
  h.selections.set("A", {
    service: null,
    config: { model: "current-A", reasoning: "ultra" },
  });
  h.chooseDirectory.mockReset().mockResolvedValue(null);
  newConversationChoice.reviewRequired = false;
  newConversationChoice.agentId = "A";
  newConversationChoice.cwd = "/work";
  newConversationChoice.service = null;
  newConversationChoice.config = { model: "current-A", reasoning: "ultra" };
  composerDrafts.update("new", () => ({
    text: "Keep my draft",
    attachments: [],
  }));
  props = {
    agents: ["A", "B"].map(
      (id) => ({ id, name: id, status: "connected" }) as AgentCardModel,
    ),
    onGoSettings: vi.fn(),
    onManageServices: vi.fn(),
    onStarted: vi.fn(),
    onProjectChange: vi.fn(),
  };
});
afterEach(() => {
  allowAutomaticConnection("A");
  allowAutomaticConnection("B");
  for (const slot of h.slots) slot.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  composerDrafts.clear("new");
});

function folderButton() {
  return render().find(
    (node) =>
      node.type === "button" &&
      [W.folder, W.changeFolder].includes(
        node.props["aria-label"] as typeof W.folder,
      ),
  )!;
}

it("asks for a working folder at send time and keeps the draft when the choice is cancelled", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  newConversationChoice.cwd = null;
  const view = composer();
  expect(folderButton().props["aria-label"]).toBe(W.folder);
  expect(view.props.disabled).toBe(false);
  // Writing folderless shows no folder hint until a send attempt is cancelled.
  expect(view.props.note).toBeNull();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
  await (view.props.onSend as Function)(
    [{ type: "text", text: "test" }],
    composerDrafts.read("new"),
  );
  expect(h.chooseDirectory).toHaveBeenCalledTimes(1);
  expect(h.open).not.toHaveBeenCalled();
  expect(newConversationChoice.cwd).toBeNull();
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(composer().props.note).toBe(STRINGS.empty.sendNeedsFolder);
});

it("clears the cancelled-folder note when the draft changes", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  newConversationChoice.cwd = null;
  const view = composer();
  await (view.props.onSend as Function)(
    [{ type: "text", text: "test" }],
    composerDrafts.read("new"),
  );
  expect(composer().props.note).toBe(STRINGS.empty.sendNeedsFolder);
  composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "edited after the cancelled choice",
  }));
  expect(composer().props.note).toBeNull();
  composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "Keep my draft",
  }));
});

it("requests exactly one send after the picked folder's draft becomes ready", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  newConversationChoice.cwd = null;
  h.chooseDirectory.mockResolvedValue("/picked-project");
  h.live = freshThreadState("picked", "A", "/picked-project", "native");
  h.live.configOptions = [
    configOption("model", "current-A", ["current-A", "other"]),
    configOption("reasoning", "ultra", ["low", "ultra"]),
  ];
  h.open.mockResolvedValue(h.live);
  const sending = await import("../runtime/new_conversation");
  const { draftPersistence } = await import("../runtime/drafts");
  const flush = vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  const dispatch = vi.spyOn(sending, "sendNewConversation").mockResolvedValue();
  try {
    const view = composer();
    expect(view.props.sendRequest).toBe(0);
    await (view.props.onSend as Function)(
      [{ type: "text", text: "test" }],
      composerDrafts.read("new"),
    );
    expect(h.chooseDirectory).toHaveBeenCalledTimes(1);
    composer();
    expect(newConversationChoice.cwd).toBe("/picked-project");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "A", cwd: "/picked-project" }),
    );
    // The armed one-shot becomes a single send request for the composer.
    expect(composer().props.sendRequest).toBe(1);
    composer();
    await vi.advanceTimersByTimeAsync(1000);
    composer();
    expect(composer().props.sendRequest).toBe(1);
    // The composer runs the request through the same send path; its send
    // pipeline marks the draft pending before invoking onSend.
    composerDrafts.update("new", (draft) => ({ ...draft, sendPending: true }));
    await (composer().props.onSend as Function)(
      [{ type: "text", text: "test" }],
      composerDrafts.read("new"),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(props.onStarted).toHaveBeenCalledWith("picked");
  } finally {
    flush.mockRestore();
    dispatch.mockRestore();
  }
});

it("drops the pending send when the draft changes before the picked folder is ready", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  newConversationChoice.cwd = null;
  h.chooseDirectory.mockResolvedValue("/picked-project");
  h.live = freshThreadState("picked", "A", "/picked-project", "native");
  h.live.configOptions = [
    configOption("model", "current-A", ["current-A", "other"]),
    configOption("reasoning", "ultra", ["low", "ultra"]),
  ];
  h.open.mockResolvedValue(h.live);
  const sending = await import("../runtime/new_conversation");
  const dispatch = vi.spyOn(sending, "sendNewConversation").mockResolvedValue();
  try {
    const view = composer();
    await (view.props.onSend as Function)(
      [{ type: "text", text: "test" }],
      composerDrafts.read("new"),
    );
    composer();
    composerDrafts.update("new", (draft) => ({
      ...draft,
      text: "changed while opening",
    }));
    composer();
    await vi.advanceTimersByTimeAsync(300);
    composer();
    expect(composer().props.sendRequest).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(composerDrafts.read("new").text).toBe("changed while opening");
    expect(props.onStarted).not.toHaveBeenCalled();
  } finally {
    dispatch.mockRestore();
  }
});

it("opens only the explicitly chosen folder, never the application preparation directory", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  newConversationChoice.cwd = null;
  h.chooseDirectory.mockResolvedValue("/chosen-project");
  h.open.mockResolvedValue(
    freshThreadState("chosen", "A", "/chosen-project", "native"),
  );
  (folderButton().props.onClick as Function)();
  await Promise.resolve();
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(newConversationChoice.cwd).toBe("/chosen-project");
  expect(h.open).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "A", cwd: "/chosen-project" }),
  );
  expect(h.open.mock.calls.some(([input]) => input.cwd === "/ordinary")).toBe(
    false,
  );
});

it("canceling folder choice leaves the new conversation unopened", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  newConversationChoice.cwd = null;
  (folderButton().props.onClick as Function)();
  await Promise.resolve();
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(newConversationChoice.cwd).toBeNull();
  expect(h.open).not.toHaveBeenCalled();
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
});

it("rejects a stale send after the working folder is cleared without falling back to the default", async () => {
  h.canonical = "/work";
  const view = composer();
  const clear = render().find(
    (node) => node.props["aria-label"] === W.clearFolder,
  )!;
  (clear.props.onClick as Function)();
  // The stale callback still rejects; sending itself stays gated by work.
  expect(composer().props.disabled).toBe(true);
  await expect(
    (view.props.onSend as Function)(
      [{ type: "text", text: "test" }],
      composerDrafts.read("new"),
    ),
  ).rejects.toThrow();
  expect(newConversationChoice.cwd).toBeNull();
  expect(h.open).not.toHaveBeenCalled();
});

it("ignores a folder picker result after leaving the new-conversation page", async () => {
  let finish!: (path: string) => void;
  h.chooseDirectory.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  (folderButton().props.onClick as Function)();
  props.active = false;
  composer();
  finish("/late-folder");
  await Promise.resolve();
  composer();
  expect(newConversationChoice.cwd).toBe("/work");
  expect(h.open).not.toHaveBeenCalled();
});

it.each(["saved-source-auth", "saved-source-read", "current-source-auth"])(
  "checks the current draft source independently from the selectable saved source (%s)",
  async (reason) => {
    vi.useFakeTimers();
    const cwd = `/source-isolation-${reason}`;
    const saved = { id: "saved-source", model: "saved-model", revision: "one" };
    const current = {
      id: "current-source",
      model: "current-model",
      revision: "two",
    };
    h.selections.set("A", { service: saved, config: {} });
    newConversationChoice.cwd = cwd;
    newConversationChoice.service = current;
    newConversationChoice.config = {};
    h.live = freshThreadState("source-draft", "A", cwd, "native");
    h.live.identity = "draft";
    h.live.service = { ...current, fingerprint: "fixture-current-source" };
    h.live.serviceContext = JSON.stringify(current);
    h.open.mockResolvedValue(h.live);
    h.enabled = true;
    const failedSource = JSON.stringify(
      reason === "current-source-auth" ? current : saved,
    );
    if (reason === "saved-source-read")
      preparationFor("A").requireExplicitRead({
        agentId: "A",
        cwd,
        source: JSON.stringify(saved),
      });
    else
      observeAuthentication("A", cwd, "AUTH_REQUIRED", failedSource, "request");
    try {
      composer();
      await vi.advanceTimersByTimeAsync(300);
      const view = composer();
      expect(view.props.disabled).toBe(reason === "current-source-auth");
      expect(newConversationChoice.service).toEqual(current);
      expect(composerDrafts.read("new").text).toBe("Keep my draft");
      if (reason === "current-source-auth")
        expect(h.open).not.toHaveBeenCalled();
      else expect(h.open).toHaveBeenCalledOnce();
    } finally {
      observeAuthentication("A", cwd, undefined, failedSource, "request");
    }
  },
);

it.each([
  ["选择 Agent", picker],
  ["模型与来源", modelPicker],
] as const)(
  "keeps the %s trigger as the dialog's explicit focus return target",
  (label, open) => {
    const trigger = nodes(composer().props.controls as ReactNode).find(
      (node) => node.props["aria-label"] === label,
    )!;
    expect(trigger.props.ref).toBeDefined();
    expect(open().props.returnFocusRef).toBe(trigger.props.ref);
  },
);

it("closes model selection before opening API management and keeps the draft and original choice", () => {
  const before = structuredClone(newConversationChoice.config);
  (modelPicker().props.onManageServices as () => void)();
  expect(
    render().some((node) => node.type === NewConversationModelDialog),
  ).toBe(false);
  expect(props.onManageServices).toHaveBeenCalledTimes(1);
  expect(newConversationChoice.config).toEqual(before);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("canceling the model dialog does not apply a setting or clear the input", () => {
  (modelPicker().props.onClose as () => void)();
  expect(
    render().some((node) => node.type === NewConversationModelDialog),
  ).toBe(false);
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("reconfirming the same API choice preserves configuration regardless of property order", async () => {
  newConversationChoice.service = {
    id: "saved",
    model: "model",
    revision: "r1",
  };
  await (modelPicker().props.onApply as (value: unknown) => Promise<void>)({
    service: { id: "saved", revision: "r1", model: "model" },
    modelValue: null,
  });
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
});

it("identifies the selected API service even when two services use the same model", async () => {
  h.credentials.mockResolvedValue([
    { id: "one", label: "Personal service" },
    { id: "two", label: "Work service" },
  ]);
  newConversationChoice.service = {
    id: "one",
    model: "shared-model",
    revision: "r1",
  };
  composer();
  await Promise.resolve();
  expect(composer().props.caption).toContain("Personal service");
  await (modelPicker().props.onApply as (value: unknown) => Promise<void>)({
    service: { id: "two", model: "shared-model", revision: "r2" },
    modelValue: null,
  });
  expect(composer().props.caption).not.toContain("Personal service");
  await Promise.resolve();
  expect(composer().props.caption).toContain("Work service");
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("ignores a stale source-label response and refreshes the label after a rename", async () => {
  let old!: (records: unknown[]) => void;
  h.credentials
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue([{ id: "two", label: "Current service" }]);
  newConversationChoice.service = {
    id: "one",
    model: "shared-model",
    revision: "r1",
  };
  composer();
  await (modelPicker().props.onApply as (value: unknown) => Promise<void>)({
    service: { id: "two", model: "shared-model", revision: "r2" },
    modelValue: null,
  });
  composer();
  await Promise.resolve();
  old([{ id: "one", label: "Wrong old service" }]);
  await Promise.resolve();
  expect(composer().props.caption).toContain("Current service");
  h.credentials.mockResolvedValue([{ id: "two", label: "Renamed service" }]);
  h.credentialListeners.forEach((listener) => listener());
  await Promise.resolve();
  expect(composer().props.caption).toContain("Renamed service");
  expect(newConversationChoice.service?.id).toBe("two");
});

it("keeps the current same-Agent draft choice instead of replacing it with its saved default", () => {
  h.selections.set("A", { service: null, config: { model: "default-A" } });
  (picker().props.onPick as (id: string) => void)("A");
  picker();
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(props.onGoSettings).not.toHaveBeenCalled();
});

it("opens a saved offline Agent on selection without changing its source or sending the draft", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  props.agents[1] = { ...props.agents[1], status: "installed" };
  h.selections.set("B", { service: null, config: {} });
  h.live = freshThreadState("new-B", "B", "/work", "native-B");
  h.live.identity = "draft";
  h.open.mockResolvedValue(h.live);
  (picker().props.onPick as (id: string) => void)("B");
  composer();
  await vi.advanceTimersByTimeAsync(251);
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.open).toHaveBeenCalledWith({
    agentId: "B",
    cwd: "/work",
    service: null,
    serviceRevision: undefined,
    fresh: false,
    inquiryCurrent: expect.any(Function),
    inquirySignal: expect.any(AbortSignal),
  });
  const inquiry = h.open.mock.calls[0][0];
  expect(inquiry.inquiryCurrent()).toBe(true);
  props.active = false;
  composer();
  expect(inquiry.inquiryCurrent()).toBe(false);
  expect(inquiry.inquirySignal.aborted).toBe(true);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(props.onGoSettings).not.toHaveBeenCalled();
});

it("does not reopen a manually disconnected Agent on refresh or return, and an explicit same-Agent choice resumes it", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  newConversationChoice.agentId = "B";
  h.selections.set("B", { service: null, config: {} });
  pauseAutomaticConnection("B");
  props.agents[1] = { ...props.agents[1], status: "installed" };
  composer();
  props.active = false;
  composer();
  props.active = true;
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
  expect(composer().props.disabled).toBe(true);
  h.live = freshThreadState("new-B", "B", "/work", "native-B");
  h.live.identity = "draft";
  h.live.configOptions = [
    configOption("model", "current-A", ["current-A"]),
    configOption("reasoning", "ultra", ["ultra"]),
  ];
  h.open.mockResolvedValue(h.live);
  (picker().props.onPick as (id: string) => void)("B");
  expect(isAutomaticConnectionAllowed("B")).toBe(true);
  composer();
  await vi.advanceTimersByTimeAsync(251);
  expect(h.open).toHaveBeenCalledOnce();
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("checks manual disconnect again before a previously scheduled pre-open can run", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  composer();
  pauseAutomaticConnection("A");
  // No render between the explicit disconnect and this old timer.
  await vi.advanceTimersByTimeAsync(251);
  expect(h.open).not.toHaveBeenCalled();
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
});

it("restores the selected Agent's confirmed source revision, model and reasoning", () => {
  const selection = {
    service: { id: "api-B", model: "Nemotron", revision: "confirmed-revision" },
    config: { model: "Nemotron", reasoning: "ultra", mode: "build" },
  };
  h.selections.set("B", selection);
  (picker().props.onPick as (id: string) => void)("B");
  expect(picker().props.picked).toBe("B");
  expect(newConversationChoice.service).toEqual(selection.service);
  expect(newConversationChoice.config).toEqual(selection.config);
  expect(h.open).not.toHaveBeenCalled();
});

it("ignores a stale picker choice when an Agent has no confirmed preparation and preserves the draft", () => {
  (picker().props.onPick as (id: string) => void)("B");
  expect(props.onGoSettings).not.toHaveBeenCalled();
  expect(picker().props.picked).toBe("A");
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(h.open).not.toHaveBeenCalled();
});

const configOption = (
  id: string,
  currentValue: string,
  options: string[],
): ConfigOptionView => ({
  id,
  category: id === "model" ? "model" : undefined,
  type: "select",
  name: id,
  currentValue,
  options: options.map((value) => ({ value, name: value })),
});
async function startEditableDraft(cwd = "/work", serviceContext?: string) {
  vi.useFakeTimers();
  newConversationChoice.cwd = cwd;
  h.live = freshThreadState("new-A", "A", cwd, "native");
  h.live.identity = "draft";
  if (newConversationChoice.service) {
    h.live.service = {
      ...newConversationChoice.service,
      fingerprint: "fixture-api",
    };
    h.live.serviceContext =
      serviceContext ?? JSON.stringify(newConversationChoice.service);
  }
  h.live.configOptions = [
    configOption("model", "current-A", ["current-A", "other"]),
    configOption("reasoning", "ultra", ["low", "ultra"]),
  ];
  h.open.mockResolvedValue(h.live);
  h.enabled = true;
  composer();
  await vi.advanceTimersByTimeAsync(251);
  expect(composer().props.disabled).toBe(false);
  expect(h.setConfig).not.toHaveBeenCalled();
}

it("holds only the visible draft's exact connection and releases that view when hidden", async () => {
  newConversationChoice.service = {
    id: "draft-source",
    model: "current-A",
    revision: "r1",
  };
  await startEditableDraft("/visible-draft", "actual-connection-source");
  expect(h.hold).toHaveBeenLastCalledWith({
    agentId: "A",
    cwd: "/visible-draft",
    serviceContext: "actual-connection-source",
  });
  props.active = false;
  composer();
  expect(h.hold).toHaveBeenLastCalledWith(null);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
});

it("rejects an old send callback after manual disconnect without reopening or clearing its draft", async () => {
  await startEditableDraft();
  const send = composer().props.onSend as (
    blocks: unknown[],
    draft: unknown,
  ) => Promise<void>;
  pauseAutomaticConnection("A");
  await expect(send([], composerDrafts.read("new"))).rejects.toThrow(
    STRINGS.repair.sendFailed,
  );
  expect(h.open).toHaveBeenCalledOnce();
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
});

function retireAgent(id = "A") {
  props.agents = props.agents.map((agent) =>
    agent.id === id
      ? { ...agent, source: "registry", firstBatchVisible: false }
      : agent,
  );
}

it("retains a restored retired choice and its unsent text without opening or automatically switching Agents", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  retireAgent();
  const before = structuredClone(newConversationChoice.config);
  const view = composer();
  await vi.advanceTimersByTimeAsync(251);
  expect(view.props.disabled).toBe(true);
  (view.props.prepareAction as () => void)();
  const choose = picker();
  expect(choose.props.picked).toBe("A");
  (choose.props.onPick as (id: string) => void)("A");
  (choose.props.onPrepare as (id: string) => void)("A");
  expect(newConversationChoice.agentId).toBe("A");
  expect(newConversationChoice.config).toEqual(before);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(h.open).not.toHaveBeenCalled();
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.discardDraft).not.toHaveBeenCalled();
  expect(props.onGoSettings).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("freezes a prepared new draft when its Agent leaves the catalog without discarding it or accepting stale actions", async () => {
  await startEditableDraft("/retired-draft");
  const send = composer().props.onSend as (...args: unknown[]) => Promise<void>;
  const apply = modelPicker().props.onApply as (
    value: unknown,
  ) => Promise<void>;
  const before = structuredClone(newConversationChoice.config);
  retireAgent();
  expect(composer().props.disabled).toBe(true);
  await expect(send([], composerDrafts.read("new"))).rejects.toThrow(
    STRINGS.repair.sendFailed,
  );
  await expect(apply({ service: null, modelValue: "other" })).rejects.toThrow(
    STRINGS.repair.configFailed,
  );
  h.live!.configOptions = [configOption("model", "other", ["other"])];
  props.initialAgentId = "A";
  props.initialAgentRevision = 2;
  props.initialSelection = { service: null, config: { model: "late-choice" } };
  render();
  await vi.advanceTimersByTimeAsync(251);
  expect(newConversationChoice.agentId).toBe("A");
  expect(newConversationChoice.config).toEqual(before);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.discardDraft).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("does not apply configuration or send when an opening draft leaves the catalog before its response", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  let finish!: (state: ThreadState) => void;
  h.open.mockImplementation(
    () =>
      new Promise<ThreadState>((resolve) => {
        finish = resolve;
      }),
  );
  composer();
  await vi.advanceTimersByTimeAsync(251);
  expect(h.open).toHaveBeenCalledOnce();
  retireAgent();
  composer();
  h.live = freshThreadState("late-A", "A", "/work", "native");
  h.live.identity = "draft";
  h.live.configOptions = [
    configOption("model", "other", ["current-A", "other"]),
  ];
  finish(h.live);
  await Promise.resolve();
  await Promise.resolve();
  expect(composer().props.disabled).toBe(true);
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.discardDraft).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("rechecks directory admission after preserving a pending target and keeps rejected input intact", async () => {
  await startEditableDraft("/retired-before-first-send");
  const { draftPersistence } = await import("../runtime/drafts");
  const sending = await import("../runtime/new_conversation");
  let finish!: () => void;
  const flush = vi.spyOn(draftPersistence, "flush").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const dispatch = vi.spyOn(sending, "sendNewConversation").mockResolvedValue();
  try {
    composerDrafts.update("new", (draft) => ({ ...draft, sendPending: true }));
    const sent = (
      composer().props.onSend as (...args: unknown[]) => Promise<void>
    )([], composerDrafts.read("new"));
    const rejected = expect(sent).rejects.toThrow(STRINGS.repair.sendFailed);
    expect(composerDrafts.read("new").pendingConversation?.agentId).toBe("A");
    retireAgent();
    render();
    finish();
    await rejected;
    expect(dispatch).not.toHaveBeenCalled();
    expect(composerDrafts.read("new").text).toBe("Keep my draft");
    expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
    expect(newConversationChoice.agentId).toBe("A");
    expect(h.discardDraft).not.toHaveBeenCalled();
    expect(props.onStarted).not.toHaveBeenCalled();
  } finally {
    flush.mockRestore();
    dispatch.mockRestore();
  }
});

it.each(["existing", "api"])(
  "rechecks current %s authentication after draft persistence before React renders",
  async (source) => {
    const cwd = `/auth-before-first-send-${source}`;
    const context =
      source === "api" ? "fixture-current-service-context" : undefined;
    if (source === "api") {
      const choice = { id: "current-api", model: "current-A", revision: "r1" };
      newConversationChoice.service = choice;
    }
    await startEditableDraft(cwd, context);
    const { draftPersistence } = await import("../runtime/drafts");
    const sending = await import("../runtime/new_conversation");
    let finish!: () => void;
    const flush = vi.spyOn(draftPersistence, "flush").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dispatch = vi
      .spyOn(sending, "sendNewConversation")
      .mockResolvedValue();
    try {
      composerDrafts.update("new", (draft) => ({
        ...draft,
        sendPending: true,
      }));
      const sent = (
        composer().props.onSend as (...args: unknown[]) => Promise<void>
      )([], composerDrafts.read("new"));
      const rejected = expect(sent).rejects.toThrow(STRINGS.repair.sendFailed);
      await vi.waitFor(() =>
        expect(composerDrafts.read("new").pendingConversation?.agentId).toBe(
          "A",
        ),
      );
      observeAuthentication("A", cwd, "AUTH_REQUIRED", context, "request");
      // No render: the action must read the latest authentication observation itself.
      finish();
      await rejected;
      expect(dispatch).not.toHaveBeenCalled();
      expect(composerDrafts.read("new").text).toBe("Keep my draft");
      expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
      expect(props.onStarted).not.toHaveBeenCalled();
      expect(h.discardDraft).not.toHaveBeenCalled();
    } finally {
      observeAuthentication("A", cwd, undefined, context, "request");
      flush.mockRestore();
      dispatch.mockRestore();
    }
  },
);

it("does not reopen a completed Agent's new draft after a configuration operation requires explicit reading", async () => {
  vi.useFakeTimers();
  const cwd = "/configuration-return-unread";
  h.canonical = "/canonical-configuration-return-unread";
  newConversationChoice.cwd = cwd;
  h.enabled = true;
  h.open.mockResolvedValue(freshThreadState("unused", "A", cwd, "native"));
  preparationFor("A").requireExplicitRead({ agentId: "A", cwd });
  const before = structuredClone(newConversationChoice.config);
  let view = composer();
  await vi.advanceTimersByTimeAsync(251);
  props.active = false;
  render();
  props.active = true;
  view = composer();
  await vi.advanceTimersByTimeAsync(251);
  expect(h.open).not.toHaveBeenCalled();
  expect(view.props.disabled).toBe(true);
  expect(view.props.note).toBe(C.readRequired);
  (view.props.prepareAction as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledWith(
    "A",
    expect.objectContaining({ panel: "model" }),
  );
  expect(newConversationChoice.config).toEqual(before);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
});

it("blocks stale send and model handlers as soon as configuration invalidates the original draft", async () => {
  const cwd = "/configuration-return-cached";
  await startEditableDraft(cwd);
  const send = composer().props.onSend as (...args: unknown[]) => Promise<void>;
  const apply = modelPicker().props.onApply as (
    value: unknown,
  ) => Promise<void>;
  const before = structuredClone(newConversationChoice.config);
  preparationFor("A").requireExplicitRead({ agentId: "A", cwd });
  await expect(send([], composerDrafts.read("new"))).rejects.toThrow(
    C.readRequired,
  );
  await expect(apply({ service: null, modelValue: "other" })).rejects.toThrow(
    C.readRequired,
  );
  expect(composer().props.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(251);
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual(before);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
});

it.each(["other-directory", "api-source"])(
  "does not block a different preparation target (%s)",
  async (target) => {
    vi.useFakeTimers();
    const cwd = `/configuration-return-${target}`;
    preparationFor("A").requireExplicitRead({ agentId: "A", cwd });
    newConversationChoice.cwd =
      target === "other-directory" ? `${cwd}/other` : cwd;
    newConversationChoice.config = {};
    if (target === "api-source")
      newConversationChoice.service = {
        id: "api",
        model: "chosen",
        revision: "r1",
      };
    h.enabled = true;
    h.open.mockResolvedValue(
      freshThreadState("other", "A", newConversationChoice.cwd, "native"),
    );
    composer();
    await vi.advanceTimersByTimeAsync(251);
    expect(h.open).toHaveBeenCalledOnce();
    expect(preparationFor("A").getSnapshot().explicitReadTargets).toContain(
      JSON.stringify(["A", cwd, null]),
    );
  },
);

it("changes the confirmed model only on apply and preserves the user's reasoning choice", async () => {
  await startEditableDraft();
  h.setConfig.mockImplementation(async (_key, id, value) => {
    h.live!.configOptions =
      id === "model"
        ? [
            configOption("model", value, ["current-A", "other"]),
            configOption("reasoning", "low", ["low", "ultra"]),
          ]
        : h.live!.configOptions.map((option) =>
            option.id === id ? { ...option, currentValue: value } : option,
          );
  });
  const apply = modelPicker().props.onApply as (
    value: unknown,
  ) => Promise<void>;
  expect(h.setConfig).not.toHaveBeenCalled();
  await apply({ service: null, modelValue: "other" });
  expect(h.setConfig.mock.calls.map(([, id, value]) => [id, value])).toEqual([
    ["model", "other"],
    ["reasoning", "ultra"],
  ]);
  expect(newConversationChoice.config).toEqual({
    model: "other",
    reasoning: "ultra",
  });
  expect(composer().props.disabled).toBe(false);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
});

it.each([
  "model-not-confirmed",
  "reasoning-unavailable",
  "reasoning-not-confirmed",
  "later-model-drift",
])(
  "keeps the original choice and disables sending when model apply is not fully confirmed (%s)",
  async (failure) => {
    await startEditableDraft();
    h.setConfig.mockImplementation(async (_key, id, value) => {
      if (id === "model")
        h.live!.configOptions = [
          configOption(
            "model",
            failure === "model-not-confirmed" ? "current-A" : value,
            ["current-A", "other"],
          ),
          configOption(
            "reasoning",
            "low",
            failure === "reasoning-unavailable" ? ["low"] : ["low", "ultra"],
          ),
        ];
      else if (failure === "later-model-drift")
        h.live!.configOptions = [
          configOption("model", "current-A", ["current-A", "other"]),
          configOption("reasoning", value, ["low", "ultra"]),
        ];
    });
    await expect(
      (modelPicker().props.onApply as (value: unknown) => Promise<void>)({
        service: null,
        modelValue: "other",
      }),
    ).rejects.toThrow(STRINGS.repair.configFailed);
    const view = composer();
    expect(newConversationChoice.config).toEqual({
      model: "current-A",
      reasoning: "ultra",
    });
    expect(view.props.disabled).toBe(true);
    expect((view.props.note as { message: string }).message).toContain(
      STRINGS.repair.configFailed,
    );
    expect(composerDrafts.read("new").text).toBe("Keep my draft");
    expect(props.onStarted).not.toHaveBeenCalled();
    expect(
      h.setConfig.mock.calls.filter(([, id]) => id === "model"),
    ).toHaveLength(1);
  },
);

it("does not overwrite a different Agent's choice when an older model application finishes", async () => {
  await startEditableDraft();
  let finish!: () => void;
  h.setConfig.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = (
    modelPicker().props.onApply as (value: unknown) => Promise<void>
  )({ service: null, modelValue: "other" });
  const oldDraft = h.live!;
  h.selections.set("B", {
    service: null,
    config: { model: "Nemotron", reasoning: "ultra" },
  });
  (picker().props.onPick as (id: string) => void)("B");
  render();
  oldDraft.configOptions = [
    configOption("model", "other", ["current-A", "other"]),
    configOption("reasoning", "low", ["low", "ultra"]),
  ];
  finish();
  await pending;
  expect(newConversationChoice.agentId).toBe("B");
  expect(newConversationChoice.config).toEqual({
    model: "Nemotron",
    reasoning: "ultra",
  });
  expect(h.setConfig).toHaveBeenCalledTimes(1);
});

it("does not overwrite a newer explicit same-Agent selection when an older application finishes", async () => {
  await startEditableDraft();
  let finish!: () => void;
  h.setConfig.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = (
    modelPicker().props.onApply as (value: unknown) => Promise<void>
  )({ service: null, modelValue: "other" });
  props.initialAgentId = "A";
  props.initialAgentRevision = 1;
  props.initialSelection = {
    requiresReview: true,
    service: null,
    config: { model: "newer-A", reasoning: "ultra" },
  };
  render();
  finish();
  await pending;
  expect(newConversationChoice.config).toEqual({
    model: "newer-A",
    reasoning: "ultra",
  });
  expect(h.setConfig).toHaveBeenCalledTimes(1);
  expect(newConversationChoice.reviewRequired).toBe(true);
});

function startDynamicDraft() {
  vi.useFakeTimers();
  h.live = freshThreadState("new-B", "B", "/work", "native");
  h.live.identity = "draft";
  h.live.configOptions = [
    configOption("reasoning", "low", ["low"]),
    configOption("model", "default", ["default", "Nemotron"]),
    configOption("mode", "build", ["build"]),
  ];
  h.open.mockResolvedValue(h.live);
  h.selections.set("B", {
    service: null,
    config: { reasoning: "ultra", model: "Nemotron", mode: "build" },
  });
  (picker().props.onPick as (id: string) => void)("B");
  h.enabled = true;
  composer();
}

it("applies the model first and reads the newly returned reasoning choices before restoring Ultra", async () => {
  startDynamicDraft();
  h.setConfig.mockImplementation(
    async (_key: string, id: string, value: string) => {
      if (id === "model")
        h.live!.configOptions = [
          configOption("model", value, ["default", "Nemotron"]),
          configOption("reasoning", "low", ["low", "ultra"]),
          configOption("mode", "build", ["build"]),
        ];
      else
        h.live!.configOptions = h.live!.configOptions.map((option) =>
          option.id === id ? { ...option, currentValue: value } : option,
        );
    },
  );
  await vi.advanceTimersByTimeAsync(251);
  expect(h.setConfig.mock.calls.map(([, id, value]) => [id, value])).toEqual([
    ["model", "Nemotron"],
    ["reasoning", "ultra"],
  ]);
  expect(composer().props.disabled).toBe(false);
  expect(newConversationChoice.config).toEqual({
    model: "Nemotron",
    reasoning: "ultra",
    mode: "build",
  });
});

it.each([
  "unavailable-model",
  "unavailable-reasoning",
  "unconfirmed-reasoning",
  "later-model-drift",
])(
  "preserves the selected configuration and offers model repair instead of downgrading (%s)",
  async (failure) => {
    startDynamicDraft();
    if (failure === "unavailable-model")
      h.live!.configOptions = [configOption("model", "default", ["default"])];
    h.setConfig.mockImplementation(
      async (_key: string, id: string, value: string) => {
        if (id === "model")
          h.live!.configOptions = [
            configOption("model", value, ["default", "Nemotron"]),
            configOption(
              "reasoning",
              "low",
              failure === "unavailable-reasoning" ? ["low"] : ["low", "ultra"],
            ),
            configOption("mode", "build", ["build"]),
          ];
        if (id === "reasoning" && failure === "later-model-drift")
          h.live!.configOptions = [
            configOption("model", "default", ["default", "Nemotron"]),
            configOption("reasoning", value, ["low", "ultra"]),
            configOption("mode", "build", ["build"]),
          ];
      },
    );
    await vi.advanceTimersByTimeAsync(251);
    const view = composer();
    expect(view.props.disabled).toBe(true);
    expect(newConversationChoice.config).toEqual({
      model: "Nemotron",
      reasoning: "ultra",
      mode: "build",
    });
    expect(view.props.thread).toBeNull();
    (view.props.onGoSettings as () => void)();
    expect(props.onGoSettings).toHaveBeenCalledWith(
      "B",
      expect.objectContaining({ panel: "model" }),
    );
    expect((view.props.note as { message: string }).message).toContain(
      STRINGS.repair.configFailed,
    );
  },
);

it("exposes only a prepared real draft and keeps its original input and attachment slot on return", async () => {
  props.onPreparedKey = vi.fn();
  const attachment = {
    id: "fixture",
    kind: "file" as const,
    name: "fixture.txt",
    uri: "file:///fixture.txt",
  };
  composerDrafts.update("new", (draft) => ({
    ...draft,
    attachments: [attachment],
  }));
  const original = composerDrafts.read("new");
  await startEditableDraft();
  expect(props.onPreparedKey).toHaveBeenLastCalledWith("new-A");
  expect(h.live!.identity).toBe("draft");
  expect(composer().props.draftKey).toBe("new");
  props.active = false;
  render();
  props.active = true;
  render();
  expect(props.onPreparedKey).toHaveBeenLastCalledWith("new-A");
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.discardDraft).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(original);
  expect(props.onStarted).not.toHaveBeenCalled();
  h.live!.configuring = true;
  render();
  expect(props.onPreparedKey).toHaveBeenLastCalledWith("new-A");
  expect(composer().props.disabled).toBe(true);
});

it.each(["rejected", "unknown"])(
  "uses the original first-send protection from the prepared workspace (%s)",
  async (outcome) => {
    props.onPreparedKey = vi.fn();
    await startEditableDraft();
    const { draftPersistence } = await import("../runtime/drafts");
    const sending = await import("../runtime/new_conversation");
    const flush = vi.spyOn(draftPersistence, "flush").mockResolvedValue();
    const dispatch = vi
      .spyOn(sending, "sendNewConversation")
      .mockImplementation(async () => {
        if (outcome === "unknown")
          h.live!.uncertainPrompt = [{ type: "text", text: "Keep my draft" }];
        throw new Error("controlled rejection");
      });
    try {
      composerDrafts.update("new", (draft) => ({
        ...draft,
        sendPending: true,
      }));
      const blocks = [{ type: "text", text: "Keep my draft" }];
      await expect(
        (composer().props.onSend as Function)(
          blocks,
          composerDrafts.read("new"),
        ),
      ).rejects.toThrow("controlled rejection");
      expect(dispatch).toHaveBeenCalledWith("new-A", blocks);
      expect(composerDrafts.read("new").text).toBe("Keep my draft");
      expect(!!composerDrafts.read("new").pendingConversation).toBe(
        outcome === "unknown",
      );
      expect(composer().props.onRecoverPending).toBeTypeOf("function");
      expect(props.onStarted).not.toHaveBeenCalled();
      expect(h.discardDraft).not.toHaveBeenCalled();
    } finally {
      flush.mockRestore();
      dispatch.mockRestore();
    }
  },
);

it("keeps a single portal host and original input while moving the prepared editor, restoring its focus", async () => {
  const focused = { focus: vi.fn() };
  const root = {
    className: "",
    contains: vi.fn((value) => value === focused),
    remove: vi.fn(),
  };
  const createElement = vi.fn(() => root);
  vi.stubGlobal("document", { createElement, activeElement: focused });
  props.onPreparedKey = vi.fn();
  await startEditableDraft();
  const original = composerDrafts.read("new");
  const first = { appendChild: vi.fn() };
  props.composerTarget = first as unknown as HTMLElement;
  render();
  expect(first.appendChild).toHaveBeenCalledWith(root);
  expect(focused.focus).toHaveBeenCalledWith({ preventScroll: true });
  const second = { appendChild: vi.fn() };
  props.composerTarget = second as unknown as HTMLElement;
  render();
  expect(second.appendChild).toHaveBeenCalledWith(root);
  expect(createElement).toHaveBeenCalledOnce();
  expect(new Set(h.portalTargets)).toEqual(new Set([root]));
  expect(root.remove).not.toHaveBeenCalled();
  expect(composer().props.draftKey).toBe("new");
  expect(composerDrafts.read("new")).toBe(original);
});

it("releases the prepared editor after recovering the original pending target without resending", async () => {
  props.onPreparedKey = vi.fn();
  await startEditableDraft();
  const recovery = await import("../runtime/pending_conversation");
  const recover = vi
    .spyOn(recovery, "recoverPendingConversation")
    .mockResolvedValue("new-A");
  try {
    const original = composerDrafts.read("new");
    await (composer().props.onRecoverPending as Function)({
      agentId: "A",
      cwd: "/work",
      nativeSessionId: "native",
    });
    render();
    expect(props.onPreparedKey).toHaveBeenLastCalledWith(null);
    expect(props.onStarted).toHaveBeenCalledWith("new-A");
    expect(composerDrafts.read("new")).toBe(original);
    expect(h.discardDraft).not.toHaveBeenCalled();
    expect(h.open).toHaveBeenCalledOnce();
  } finally {
    recover.mockRestore();
  }
});

it("shows onboarding with direct connect options when no Agent is mine", () => {
  props.agents = [
    {
      id: "C",
      name: "Codex",
      status: "discovered",
      source: "discovered",
    } as AgentCardModel,
    {
      id: "D",
      name: "Delta",
      status: "none",
      source: "registry",
      installable: true,
    } as AgentCardModel,
  ];
  const welcome = render().find(
    (node) => node.props.className === "workspace-welcome",
  );
  expect(welcome).toBeDefined();
  const buttons = nodes(welcome!.props.children as ReactNode).filter(
    (node) => node.type === "button",
  );
  expect(buttons.length).toBeGreaterThanOrEqual(3);
  (buttons[0]!.props.onClick as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledWith("C");
  (buttons.at(-1)!.props.onClick as () => void)();
  expect(props.onGoSettings).toHaveBeenLastCalledWith();
});

it("skips onboarding once an Agent belongs to me", () => {
  props.agents = [
    {
      id: "C",
      name: "Codex",
      status: "discovered",
      source: "discovered",
    } as AgentCardModel,
    ...props.agents,
  ];
  expect(
    render().find((node) => node.props.className === "workspace-welcome"),
  ).toBeUndefined();
});

it("holds unknown historical sources until the user explicitly chooses the existing source", async () => {
  vi.useFakeTimers();
  h.enabled = true;
  newConversationChoice.reviewRequired = true;
  newConversationChoice.config = { model: "unknown-old-model" };
  expect(composer().props.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
  await expect(
    (composer().props.onSend as Function)([], composerDrafts.read("new")),
  ).rejects.toThrow("尚未确认");
  h.live = freshThreadState("confirmed", "A", "/work", "native");
  h.open.mockResolvedValue(h.live);
  await (modelPicker().props.onApply as Function)({
    service: null,
    modelValue: null,
  });
  composer();
  expect(newConversationChoice.reviewRequired).toBe(false);
  expect(newConversationChoice.config).toEqual({});
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
});
