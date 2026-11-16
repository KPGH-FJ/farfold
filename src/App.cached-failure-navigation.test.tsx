import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { threads as appThreads } from "./runtime/sessions";
import type { IndexRow, OpenInput, ThreadState } from "./runtime/sessions";
import { browserSurfaceGuard } from "./runtime/browser_surface";
import {
  allowAutomaticConnection,
  isAutomaticConnectionAllowed,
  pauseAutomaticConnection,
} from "./runtime/connection_intent";

// Reuse the existing App hook/component harness, while its command spies
// delegate to the production store. Only the Tauri transport is replaced.
let actual: typeof import("./runtime/sessions");
let drafts: typeof import("./runtime/drafts");
let sequence = 0;
beforeAll(async () => {
  vi.doUnmock("./runtime/drafts");
  drafts = await vi.importActual("./runtime/drafts");
  actual = await vi.importActual("./runtime/sessions");
});
beforeEach(async () => {
  // resetHarness seeds its own minimal UI rows; never insert those stubs into
  // the production map retained by the previous test.
  h.threads = new Map();
  await resetHarness();
  h.invoke.mockImplementation(async (name: string, args?: { cwd?: string }) => {
    if (name === "session_open") throw new Error("AGENT_OPEN_TIMEOUT");
    if (name === "agent_work_get") return { cwd: args?.cwd, enabled: {} };
    if (name === "default_work_directory") return "/ordinary";
    if (name === "settings_get") return null;
    return [];
  });
  h.threads = actual.threads.getSnapshot().threads as typeof h.threads;
  h.open.mockImplementation((input: OpenInput) => actual.threads.open(input));
  h.reconnect.mockImplementation(
    (...args: Parameters<typeof actual.threads.reconnect>) =>
      actual.threads.reconnect(...args),
  );
  vi.mocked(appThreads.markOpenFailed).mockImplementation(
    actual.threads.markOpenFailed.bind(actual.threads),
  );
});
afterEach(async () => {
  cleanupHarness();
  for (const state of [...actual.threads.getSnapshot().threads.values()]) {
    await actual.threads.close(state.key);
    drafts.composerDrafts.clear(`session:${state.key}`);
    allowAutomaticConnection(state.agentId);
  }
});

function fixture(nativeSessionId?: string) {
  nativeSessionId ??= `native-${sequence + 1}`;
  ++sequence;
  const agentId = `cached-failure-${sequence}`;
  const cwd = `/controlled-only/navigation-${sequence}`;
  const key = `${agentId}:${cwd}:${nativeSessionId}`;
  const state = actual.threads.markOpenFailed(
    key,
    agentId,
    cwd,
    nativeSessionId,
    "original load failure remains visible",
  );
  state.connectionLost = true;
  state.configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "saved-model",
      options: [{ value: "saved-model", name: "Saved" }],
    },
  ];
  state.service = {
    id: "saved-service",
    model: "saved-model",
    fingerprint: "saved-source",
  };
  const unknown = [{ type: "text" as const, text: "original unknown input" }];
  state.queued = [unknown, [{ type: "text", text: "paused later input" }]];
  state.uncertainPrompt = unknown;
  state.queuePaused = "uncertain";
  state.connectionOutcomeUnknown = true;
  state.workEnabled = false;
  drafts.composerDrafts.update(`session:${key}`, () => ({
    text: "new unsent typing",
    attachments: [
      {
        id: "owned-attachment",
        kind: "file",
        name: "keep.txt",
        uri: "file:///controlled-only/keep.txt",
      },
    ],
  }));
  const row: IndexRow = {
    id: key,
    agentId,
    cwd,
    nativeSessionId,
    title: "Original failed conversation",
    configOptions: state.configOptions,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  };
  h.index = [row];
  h.invoke.mockClear();
  return { state, row };
}
function snapshot(state: ThreadState) {
  return {
    draft: drafts.composerDrafts.read(`session:${state.key}`),
    configOptions: state.configOptions,
    service: state.service,
    queued: state.queued,
    uncertain: state.uncertainPrompt,
    paused: state.queuePaused,
    work: state.workEnabled,
  };
}
function expectPreserved(
  state: ThreadState,
  saved: ReturnType<typeof snapshot>,
) {
  expect(actual.threads.thread(state.key)).toBe(state);
  expect(drafts.composerDrafts.read(`session:${state.key}`)).toBe(saved.draft);
  expect(state.configOptions).toBe(saved.configOptions);
  expect(state.service).toBe(saved.service);
  expect(state.queued).toBe(saved.queued);
  expect(state.uncertainPrompt).toBe(saved.uncertain);
  expect(state.queuePaused).toBe(saved.paused);
  expect(state.workEnabled).toBe(saved.work);
  expect(
    h.invoke.mock.calls.filter(([name]) =>
      [
        "session_prompt",
        "session_set_config",
        "session_confirm_config",
      ].includes(name),
    ),
  ).toEqual([]);
}
const opens = () =>
  h.invoke.mock.calls.filter(([name]) => name === "session_open");
async function settled() {
  for (const request of [h.open, h.reconnect])
    await Promise.all(
      request.mock.results.map((result) =>
        Promise.resolve(result.value).catch(() => undefined),
      ),
    );
  expect(
    [...actual.threads.getSnapshot().threads.values()].some(
      (state) => state.reconnecting,
    ),
  ).toBe(false);
  render();
}

it.each([false, true])(
  "sidebar only displays a cached failure without implicit recovery (lost=%s)",
  async (lost) => {
    const { state, row } = fixture();
    state.connectionLost = lost;
    const saved = snapshot(state);
    pauseAutomaticConnection(state.agentId);
    call("Sidebar", "onOpenRow", row);
    await settled();
    expect(component("ThreadPage").viewKey).toBe(state.key);
    expect(opens()).toEqual([]);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(isAutomaticConnectionAllowed(state.agentId)).toBe(false);
    expect(state.openError).toBe("original load failure remains visible");
    expectPreserved(state, saved);
  },
);

it.each([null, undefined, ""])(
  "keeps the same cached missing-native error instead of rewriting it (%s)",
  async (nativeSessionId) => {
    const { state, row } = fixture("");
    const saved = snapshot(state);
    pauseAutomaticConnection(state.agentId);
    call("Sidebar", "onOpenRow", { ...row, nativeSessionId });
    await settled();
    expect(component("ThreadPage").viewKey).toBe(state.key);
    expect(state.openError).toBe("original load failure remains visible");
    expect(isAutomaticConnectionAllowed(state.agentId)).toBe(false);
    expect(opens()).toEqual([]);
    expectPreserved(state, saved);
  },
);

it.each(["agentId", "cwd", "nativeSessionId"] as const)(
  "does not treat a cached error with a different %s as this row's failed view",
  async (field) => {
    const { row } = fixture();
    const changed = { ...row, [field]: `${row[field]}-different` };
    call("Sidebar", "onOpenRow", changed);
    await settled();
    expect(opens()).toHaveLength(1);
    expect(opens()[0][1]).toMatchObject({
      agentId: changed.agentId,
      cwd: changed.cwd,
      nativeSessionId: changed.nativeSessionId,
    });
  },
);

it("still opens an uncached original row once", async () => {
  const { state, row } = fixture();
  await actual.threads.close(state.key);
  h.invoke.mockClear();
  call("Sidebar", "onOpenRow", row);
  await settled();
  expect(opens()).toHaveLength(1);
});

it("keeps the existing idle reconnect path when there is no open error", async () => {
  const { state, row } = fixture();
  state.openError = null;
  const saved = snapshot(state);
  call("Sidebar", "onOpenRow", row);
  await settled();
  expect(opens()).toHaveLength(1);
  expectPreserved(state, saved);
});

it("still only displays a healthy cached row", async () => {
  const { state, row } = fixture();
  state.openError = null;
  state.connectionLost = false;
  call("Sidebar", "onOpenRow", row);
  await settled();
  expect(opens()).toEqual([]);
});

it("the existing explicit recover callback still dispatches once and preserves user work", async () => {
  const { state } = fixture();
  const saved = snapshot(state);
  call("Sidebar", "onSettings");
  call("SettingsPage", "onOpenConversation", state.key);
  expect(opens()).toEqual([]);
  call("ThreadPage", "onRecover", state.key);
  await settled();
  expect(h.reconnect).toHaveBeenCalledTimes(1);
  expect(opens()).toHaveLength(1);
  expectPreserved(state, saved);
});

it("waits for the existing browser hide barrier before displaying the cached failure", async () => {
  const { state, row } = fixture();
  const saved = snapshot(state);
  let finish!: () => void;
  const hidden = new Promise<void>((resolve) => (finish = resolve));
  const surface = browserSurfaceGuard.register(() => hidden);
  try {
    call("Sidebar", "onOpenRow", row);
    expect(opens()).toEqual([]);
    expect(render().some((node) => node.props.viewKey === state.key)).toBe(
      false,
    );
    finish();
    await vi.waitFor(() =>
      expect(browserSurfaceGuard.getSnapshot().busy).toBe(false),
    );
    await settled();
    expect(component("ThreadPage").viewKey).toBe(state.key);
    expect(opens()).toEqual([]);
    expectPreserved(state, saved);
  } finally {
    surface.release();
  }
});
