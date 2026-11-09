import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  draft: { ready: false, error: null as string | null },
  setup: { ready: false, error: null as string | null },
  draftLoad: vi.fn(),
  setupLoad: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (i >= h.states.length) h.states.push(initial);
    return [
      h.states[i],
      (v: unknown) => {
        h.states[i] = typeof v === "function" ? v(h.states[i]) : v;
      },
    ];
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (fn: () => void) => h.effects.push(fn),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../runtime/drafts", () => ({
  draftPersistence: { load: h.draftLoad },
}));
vi.mock("../runtime/draft_storage", () => ({
  useDraftSaveStatus: () => h.draft,
  DRAFT_STRINGS: { loading: "loading", loadFailed: "failed" },
}));
vi.mock("../runtime/setup_storage", () => ({
  setupStorage: { load: h.setupLoad },
  useSetupStorage: () => h.setup,
  SETUP_STORAGE_STRINGS: { loading: "loading" },
}));
vi.mock("../runtime/sessions", () => ({ threads: {} }));
vi.mock("../runtime/conversation_read_state", () => ({
  conversationReadState: {},
}));
vi.mock("../runtime/exit_impact", () => ({
  exitReviewReason: () => null,
  hasUnknownFinishedFileCopies: () => false,
  EXIT_IMPACT: {},
}));
vi.mock("../runtime/file_copy_jobs", () => ({
  hasUnsettledFileCopies: () => false,
  useFileCopyJobs: () => [],
}));
vi.mock("./FileCopyJobsStatus", () => ({ FileCopyJobsStatus: () => null }));
vi.mock("./StorageRecovery", () => ({ StorageRecovery: () => null }));
import { DraftStartup } from "./DraftStartup";
import { StorageRecovery } from "./StorageRecovery";
function render() {
  h.cursor = 0;
  return DraftStartup({ children: "editor" });
}
beforeEach(() => {
  h.states = [];
  h.effects = [];
  h.draft = { ready: false, error: null };
  h.setup = { ready: false, error: null };
  h.invoke.mockReset();
  h.draftLoad.mockReset();
  h.setupLoad.mockReset();
});
it.each(["draft", "setup"] as const)(
  "waits for the other read when %s fails first",
  async (first) => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const late = first === "draft" ? "setup" : "draft";
    h[`${first}Load`].mockImplementation(async () => {
      h[first].error = "cannot read";
      throw Error("fixture");
    });
    h[`${late}Load`].mockImplementation(async () => {
      await waiting;
      h[late].ready = true;
    });
    render();
    h.effects[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render().type).not.toBe(StorageRecovery);
    expect(h.invoke).not.toHaveBeenCalled();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const view = render();
    expect(view.type).toBe(StorageRecovery);
    expect((view.props as { restoreKeys: string[] }).restoreKeys).toEqual([
      first === "draft" ? "unsentWork.v1" : "agentSetup.v1",
    ]);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);
