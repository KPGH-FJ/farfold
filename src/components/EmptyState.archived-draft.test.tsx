import { NewConversationLocationBar } from "./NewConversationLocationBar";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Credential } from "../runtime/credentials";
import type { ThreadState } from "../runtime/session_types";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  credentials: vi.fn(),
  chooseDirectory: vi.fn(),
  open: vi.fn(),
  send: vi.fn(),
  discard: vi.fn(),
  load: vi.fn(),
  setConfig: vi.fn(),
  thread: null as ThreadState | null,
  catalogue: {
    ready: true,
    loading: false,
    error: null as string | null,
    archives: [] as unknown[],
    recoveries: [] as unknown[],
  },
}));
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
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
vi.mock("../runtime/worktrees", () => ({
  worktrees: {
    snapshot: () => h.catalogue,
    subscribe: () => () => {},
    load: h.load,
  },
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: h.chooseDirectory }));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
}));
vi.mock("../runtime/connection_hold", () => ({ useConnectionHold: () => {} }));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: h.credentials,
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: () => ({ service: null, config: {} }),
  },
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: (key: string | null) => (key === h.thread?.key ? h.thread : null),
  threads: {
    open: h.open,
    thread: () => h.thread,
    discardDraft: h.discard,
    setConfig: h.setConfig,
  },
}));
vi.mock("../runtime/new_conversation", () => ({ sendNewConversation: h.send }));
import { EmptyState } from "./EmptyState";
import { Composer } from "./Composer";
import { ErrorNotice } from "./ErrorNotice";
import { WORKTREE_STRINGS as WT } from "../runtime/worktree_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { ArchivedWorkLocationNotice } from "./ArchivedWorkLocationNotice";
import {
  removalArchive,
  removalRecovery,
} from "../runtime/worktree_remove.test-fixtures";
import {
  composerDrafts,
  fileFeedbackDrafts,
  newConversationChoice,
} from "../runtime/drafts";
import { discardEmptyDraft } from "../runtime/session_draft_cleanup";
import { allowAutomaticConnection } from "../runtime/connection_intent";
import { freshThreadState } from "../runtime/session_projection";
import type { AgentCardModel } from "../runtime/agents";
type Element = ReactElement<Record<string, unknown>>;
const props = {
  active: true,
  agents: [
    {
      id: "service-review",
      name: "Agent",
      status: "connected",
    } as AgentCardModel,
  ],
  onGoSettings: vi.fn(),
  onStarted: vi.fn(),
  onPreparedKey: vi.fn(),
  onProjectChange: vi.fn(),
};
function nodes(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [
          child,
          ...nodes(
            child.type === NewConversationLocationBar
              ? NewConversationLocationBar(
                  child.props as ComponentProps<
                    typeof NewConversationLocationBar
                  >,
                )
              : (child.props.children as ReactNode),
          ),
        ]
      : [],
  );
}
function render(): Element[] {
  for (let n = 0; n < 10; n++) {
    h.cursor = 0;
    const view = nodes(EmptyState(props));
    if (!h.effects.length) return view;
    h.effects.splice(0).forEach((effect) => effect());
  }
  throw new Error("render loop");
}
function composer(): Element {
  return render().find((node) => node.type === Composer)!;
}
const credential: Credential = {
  id: "api",
  label: "Service",
  provider: "custom",
  endpoint: "https://new.example/api",
  apiType: "responses",
  models: ["model"],
  revision: "current",
  fingerprint: "new-source",
  complete: true,
  deleting: false,
  grants: [],
};
beforeEach(() => {
  h.catalogue = {
    ready: true,
    loading: false,
    error: null,
    archives: [],
    recoveries: [],
  };
  vi.useFakeTimers();
  h.slots = [];
  h.effects = [];
  h.credentials.mockReset().mockResolvedValue([credential]);
  h.open
    .mockReset()
    .mockResolvedValue(
      freshThreadState("prepared", "service-review", "/project", "native"),
    );
  h.send.mockReset();
  h.discard.mockReset();
  h.load.mockReset().mockResolvedValue(undefined);
  h.setConfig.mockReset();
  h.thread = null;
  props.onPreparedKey.mockClear();
  props.onStarted.mockClear();
  h.chooseDirectory.mockReset();
  props.active = true;
  allowAutomaticConnection("service-review");
  Object.assign(newConversationChoice, {
    agentId: "service-review",
    cwd: "/project",
    reviewRequired: false,
    service: { id: "api", model: "model", revision: "current" },
    config: {},
  });
  composerDrafts.update("new", () => ({
    text: "Keep this draft",
    attachments: [
      {
        id: "kept-attachment",
        kind: "file",
        name: "keep.txt",
        content: "attachment survives",
      },
    ],
  }));
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  vi.useRealTimers();
  composerDrafts.clear("new");
  fileFeedbackDrafts.clear("warm-ready", "/project/report.pdf");
});

const archived = { ...removalArchive, originalPath: "/project" };

async function presentWarmDraft() {
  const state = freshThreadState(
    "warm-ready",
    "service-review",
    "/project",
    "native",
  );
  state.service = { id: "api", model: "model", fingerprint: "new-source" };
  h.open.mockImplementation(async () => {
    h.thread = state;
    return state;
  });
  // Execute the production empty-draft guard and its synchronous retirement,
  // not just a discard spy. The bridge is controlled; no Agent is launched.
  h.discard.mockImplementation(async (key: string) => {
    await discardEmptyDraft(
      h.thread?.key === key ? h.thread : undefined,
      (removed) => {
        if (h.thread === removed) h.thread = null;
      },
    );
  });
  render();
  await vi.advanceTimersByTimeAsync(300);
  render();
  expect(props.onPreparedKey).toHaveBeenLastCalledWith(state.key);
  expect(h.thread).toBe(state);
  expect(h.open).toHaveBeenCalledOnce();
  return state;
}

it.each(["explicit-discard", "archive-cleanup"])(
  "withdraws the already presented workspace after %s without consuming the original draft",
  async (retirement) => {
    const state = await presentWarmDraft();
    fileFeedbackDrafts.update(state.key, "/project/report.pdf", {
      text: "Keep the old version opinion",
      selection: null,
      contentId: 'disk:["/project/report.pdf","old","hash"]',
      scope: "file",
      anchor: { kind: "pdf-page", page: 2, pageCount: 3 },
    });
    const original = composerDrafts.read("new");
    const feedback = fileFeedbackDrafts.entries(state.key);
    const choice = structuredClone({ ...newConversationChoice });
    if (retirement === "archive-cleanup") {
      h.catalogue.archives = [archived];
      render();
    } else await h.discard(state.key);
    render();
    expect(h.thread).toBeNull();
    expect(props.onPreparedKey).toHaveBeenLastCalledWith(null);
    expect(composerDrafts.read("new")).toBe(original);
    expect(fileFeedbackDrafts.entries(state.key)).toBe(feedback);
    expect({ ...newConversationChoice }).toEqual(choice);
    expect(composer().props.draftKey).toBe("new");
    if (retirement === "archive-cleanup")
      expect(
        render().some((node) => node.type === ArchivedWorkLocationNotice),
      ).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.send).not.toHaveBeenCalled();
    expect(props.onStarted).not.toHaveBeenCalled();
  },
);

it.each(["connectionLost", "configuring"] as const)(
  "retains the same still-existing workspace during %s",
  async (field) => {
    const state = await presentWarmDraft();
    const original = composerDrafts.read("new");
    state[field] = true;
    render();
    expect(props.onPreparedKey).toHaveBeenLastCalledWith(state.key);
    expect(h.thread).toBe(state);
    expect(composer().props.disabled).toBe(true);
    expect(h.discard).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(original);
  },
);

it.each(["established", "queued", "uncertain"])(
  "does not retire protected %s content when the empty-draft cleanup is attempted",
  async (protection) => {
    const state = await presentWarmDraft();
    if (protection === "established") state.identity = "established";
    else if (protection === "queued")
      state.queued = [[{ type: "text", text: "Keep queued request" }]];
    else state.uncertainPrompt = [{ type: "text", text: "Unconfirmed send" }];
    h.catalogue.archives = [archived];
    render();
    expect(h.discard).toHaveBeenCalledWith(state.key);
    expect(h.thread).toBe(state);
    expect(props.onPreparedKey).toHaveBeenLastCalledWith(state.key);
    expect(h.send).not.toHaveBeenCalled();
    expect(props.onStarted).not.toHaveBeenCalled();
  },
);

async function send() {
  const view = composer();
  return (
    view.props.onSend as (blocks: unknown[], draft: unknown) => Promise<unknown>
  )([{ type: "text", text: "keep" }], composerDrafts.read("new"));
}
it.each(["/project", "/project/subdirectory"])(
  "blocks eager open and a stale direct send for an archived draft at %s without changing draft or permission",
  async (cwd) => {
    newConversationChoice.cwd = cwd;
    h.catalogue.archives = [archived];
    const before = JSON.stringify(composerDrafts.read("new"));
    composer();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).not.toHaveBeenCalled();
    expect(composer().props.disabled).toBe(true);
    await expect(send()).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    expect(JSON.stringify(composerDrafts.read("new"))).toBe(before);
    expect(newConversationChoice.cwd).toBe(cwd);
    expect(render().some((n) => n.type === ArchivedWorkLocationNotice)).toBe(
      true,
    );
    expect(props.onGoSettings).not.toHaveBeenCalled();
  },
);
it("rechecks catalogue after asynchronous service verification even without a React render", async () => {
  let finish!: (v: Credential[]) => void;
  h.credentials.mockImplementation(
    () =>
      new Promise<Credential[]>((resolve) => {
        finish = resolve;
      }),
  );
  composer();
  await vi.advanceTimersByTimeAsync(300);
  h.catalogue.archives = [archived];
  finish([credential]);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
});
it("a remembered archive becoming visible after the timer was scheduled prevents opening", async () => {
  composer();
  h.catalogue.archives = [archived];
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
});
it("after catalogue restore normal preparation resumes, without sending or changing the saved content", async () => {
  h.catalogue.archives = [archived];
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
  h.catalogue.archives = [];
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(h.send).not.toHaveBeenCalled();
  expect(composerDrafts.read("new").text).toBe("Keep this draft");
});
it.each(["recovery", "unrelated", "loading", "error"])(
  "does not mistake %s catalogue facts for an archived draft",
  async (kind) => {
    if (kind === "recovery")
      h.catalogue.recoveries = [
        { ...removalRecovery, originalPath: "/project" },
      ];
    else
      h.catalogue.archives = [
        // Loading/error without a matching known archive must not invent one.
        { ...archived, originalPath: "/project-other" },
      ];
    h.catalogue.loading = kind === "loading";
    h.catalogue.error = kind === "error" ? "read failed" : null;
    composer();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(render().some((n) => n.type === ArchivedWorkLocationNotice)).toBe(
      false,
    );
    expect(h.send).not.toHaveBeenCalled();
  },
);

it("late prepared connection is discarded after its directory is archived even if the view has since hidden", async () => {
  let finish!: (v: ReturnType<typeof freshThreadState>) => void;
  h.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).toHaveBeenCalledOnce();
  h.catalogue.archives = [archived];
  composer();
  props.active = false;
  composer();
  finish(
    freshThreadState("late-archived", "service-review", "/project", "native"),
  );
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(h.discard).toHaveBeenCalledExactlyOnceWith("late-archived");
  expect(h.send).not.toHaveBeenCalled();
});
it("archive rejection after service await does not become a permanent generic failed-pair marker", async () => {
  let finish!: (v: Credential[]) => void;
  h.credentials.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  composer();
  await vi.advanceTimersByTimeAsync(300);
  h.catalogue.archives = [archived];
  finish([credential]);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  composer();
  h.catalogue.archives = [];
  h.credentials.mockResolvedValue([credential]);
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.send).not.toHaveBeenCalled();
});
it.each(["loading", "error"])(
  "a previously confirmed archive remains blocked during catalogue %s until a successful list releases it",
  async (kind) => {
    h.catalogue.archives = [archived];
    composer();
    await vi.advanceTimersByTimeAsync(300);
    h.catalogue.loading = kind === "loading";
    h.catalogue.error = kind === "error" ? "list failed" : null;
    composer();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.open).not.toHaveBeenCalled();
    await expect(send()).rejects.toThrow();
    expect(composer().props.disabled).toBe(true);
    h.catalogue = {
      ready: true,
      loading: false,
      error: null,
      archives: [],
      recoveries: [],
    };
    composer();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).toHaveBeenCalledOnce();
  },
);
it("a direct send rechecks archive association after service await before opening a session", async () => {
  composer();
  let finish!: (v: Credential[]) => void;
  h.credentials.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = send();
  const rejected = expect(sending).rejects.toThrow();
  h.catalogue.archives = [archived];
  finish([credential]);
  await rejected;
  expect(h.open).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
});

it("a real service failure is not cleared merely by restoring an archived directory", async () => {
  let finish!: (v: Credential[]) => void;
  h.credentials.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  composer();
  await vi.advanceTimersByTimeAsync(300);
  h.catalogue.archives = [archived];
  finish([]);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  composer();
  h.catalogue.archives = [];
  h.credentials.mockResolvedValue([credential]);
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
  expect(newConversationChoice.reviewRequired).toBe(true);
  expect(composer().props.disabled).toBe(true);
});
it("clearing an archived draft folder retires its barrier without affecting the old cwd or draft", async () => {
  h.catalogue.archives = [archived];
  composer();
  await vi.advanceTimersByTimeAsync(300);
  h.catalogue.loading = true;
  composer();
  const clear = render().find(
    (n) => n.type === "button" && n.props["aria-label"] === W.clearFolder,
  )!;
  expect(clear).toBeDefined();
  (clear.props.onClick as () => void)();
  composer();
  expect(newConversationChoice.cwd).toBe(null);
  expect(h.open).not.toHaveBeenCalled();
  expect(composerDrafts.read("new").text).toBe("Keep this draft");
});

it("cold slow catalogue delays eager open neutrally before discovering a remembered archive", async () => {
  h.catalogue.ready = false;
  h.load.mockImplementation(() => {
    h.catalogue.loading = true;
    return new Promise(() => {});
  });
  composer();
  await vi.advanceTimersByTimeAsync(600);
  expect(h.open).not.toHaveBeenCalled();
  expect(render().some((n) => n.type === ArchivedWorkLocationNotice)).toBe(
    false,
  );
  expect(render().some((n) => n.type === ErrorNotice)).toBe(true);
  await expect(send()).rejects.toThrow();
  h.catalogue = {
    ready: true,
    loading: false,
    error: null,
    archives: [archived],
    recoveries: [],
  };
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
  expect(render().some((n) => n.type === ArchivedWorkLocationNotice)).toBe(
    true,
  );
});
it("failed first catalogue is an explicit retry with no claim of archive and normal draft resumes after confirmed empty list", async () => {
  h.catalogue.ready = false;
  h.catalogue.error = "failed";
  const before = JSON.stringify(composerDrafts.read("new"));
  composer();
  await vi.advanceTimersByTimeAsync(600);
  expect(h.open).not.toHaveBeenCalled();
  expect(render().some((n) => n.type === ArchivedWorkLocationNotice)).toBe(
    false,
  );
  const retry = render().find(
    (n) => n.type === "button" && n.props.children === WT.refresh,
  );
  expect(retry).toBeDefined();
  (retry!.props.onClick as () => void)();
  expect(h.load).toHaveBeenCalledOnce();
  h.catalogue.ready = true;
  h.catalogue.error = null;
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.send).not.toHaveBeenCalled();
  expect(JSON.stringify(composerDrafts.read("new"))).toBe(before);
});
it("an archive discovered during config await rejects and discards the returned draft without relying on a render", async () => {
  const state = freshThreadState(
    "configured-late",
    "service-review",
    "/project",
    "native",
  );
  state.configOptions = [
    {
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: "old",
      options: [
        { value: "old", name: "Old" },
        { value: "new", name: "New" },
      ],
    },
  ];
  h.thread = state;
  h.open.mockResolvedValue(state);
  newConversationChoice.config = { mode: "new" };
  let finish!: () => void;
  h.setConfig.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          state.configOptions[0].currentValue = "new";
          resolve();
        };
      }),
  );
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.setConfig).toHaveBeenCalledOnce();
  h.catalogue.archives = [archived];
  finish();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(h.discard).toHaveBeenCalledExactlyOnceWith("configured-late");
  expect(h.slots.some((s) => s.value === "configured-late")).toBe(false);
  expect(h.send).not.toHaveBeenCalled();
});

it("a direct send's late empty draft is discarded after archive admission is withdrawn without a render", async () => {
  let finish!: (v: ReturnType<typeof freshThreadState>) => void;
  h.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  composer();
  const sending = send();
  const rejected = expect(sending).rejects.toThrow();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(h.open).toHaveBeenCalledOnce();
  const state = freshThreadState(
    "late-send",
    "service-review",
    "/project",
    "native",
  );
  h.thread = state;
  h.catalogue.archives = [archived];
  finish(state);
  await rejected;
  expect(h.send).not.toHaveBeenCalled();
  expect(h.discard).toHaveBeenCalledExactlyOnceWith("late-send");
  expect(composerDrafts.read("new").text).toBe("Keep this draft");
});

it.each(["loading", "error"])(
  "A-B-A keeps the last canonical archive association neutral during %s, without carrying it to unrelated B",
  async (kind) => {
    h.catalogue.archives = [archived];
    composer();
    const pick = async (path: string) => {
      h.chooseDirectory.mockResolvedValue(path);
      const button = render().find(
        (n) => n.type === "button" && n.props["aria-label"] === W.changeFolder,
      )!;
      (button.props.onClick as () => void)();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      composer();
    };
    await pick("/other");
    h.catalogue.loading = kind === "loading";
    h.catalogue.error = kind === "error" ? "failed" : null;
    composer();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).toHaveBeenCalledOnce();
    h.open.mockClear();
    await pick("/project");
    await vi.advanceTimersByTimeAsync(600);
    expect(h.open).not.toHaveBeenCalled();
    expect(render().some((n) => n.type === ArchivedWorkLocationNotice)).toBe(
      false,
    );
    expect(
      render().some(
        (n) =>
          n.type === ErrorNotice &&
          n.props.message === WT.draftArchiveUnconfirmed,
      ),
    ).toBe(true);
  },
);
