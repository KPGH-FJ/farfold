import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  subscribe: null as null | ((listener: () => void) => () => void),
  read: null as null | (() => string),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (subscribe: typeof h.subscribe, read: () => string) => {
    h.subscribe = subscribe;
    h.read = read;
    return read();
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command) =>
    command === "session_index_list" ? [] : null,
  ),
  Channel: class {},
}));
import { useArchiveBlockReasons } from "./archive_blockers";
import { composerDrafts, fileFeedbackDrafts } from "./drafts";
import { threads } from "./sessions";

afterEach(() => vi.restoreAllMocks());

it("updates from both live state and unsent-content notifications without another status store", () => {
  const key = "archive-subscription";
  expect(useArchiveBlockReasons([key]).get(key)).toBeNull();
  const listener = vi.fn();
  const unsubscribe = h.subscribe!(listener);
  const state = threads.markOpenFailed(key, "a", "/p", key, "fixture");
  expect(listener).toHaveBeenCalled();
  expect(JSON.parse(h.read!())).toEqual([[key, "attention"]]);
  state.openError = null;
  listener.mockClear();
  fileFeedbackDrafts.update(key, "notes.txt", {
    text: "Keep",
    selection: null,
  });
  expect(listener).toHaveBeenCalled();
  expect(JSON.parse(h.read!())).toEqual([[key, "unsent"]]);
  fileFeedbackDrafts.clear(key, "notes.txt");
  expect(JSON.parse(h.read!())).toEqual([[key, null]]);
  const stable = h.read!();
  expect(h.read!()).toBe(stable);
  unsubscribe();
  listener.mockClear();
  composerDrafts.update(`session:${key}`, () => ({
    text: "Keep",
    attachments: [],
  }));
  threads.markOpenFailed("after-unsubscribe", "a", "/p", "other", "fixture");
  expect(listener).not.toHaveBeenCalled();
  composerDrafts.clear(`session:${key}`);
});
