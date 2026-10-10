import { beforeEach, afterEach, expect, it, vi } from "vitest";
const catalogue = vi.hoisted(() => ({
  value: {
    ready: true,
    loading: false,
    error: null as string | null,
    archives: [] as unknown[],
    recoveries: [] as unknown[],
  },
}));
vi.mock("./runtime/worktrees", () => ({
  worktrees: {
    snapshot: () => catalogue.value,
    subscribe: () => () => {},
    load: vi.fn(),
  },
}));
import {
  call,
  component,
  h,
  resetHarness,
  cleanupHarness,
} from "./App.test-harness";
import { freshThreadState } from "./runtime/session_projection";
import { threads } from "./runtime/sessions";
const cwd = "/controlled/archived";
function row(loaded = true) {
  const s = freshThreadState("history", "A", cwd, "native");
  s.connectionLost = true;
  s.items = [
    {
      kind: "agent",
      id: "body",
      text: "Original body",
      streaming: false,
      time: 0,
    },
  ];
  if (loaded) h.threads.set(s.key, s);
  const r = {
    id: s.key,
    agentId: s.agentId,
    cwd,
    nativeSessionId: s.nativeSessionId,
  };
  h.index = [r];
  return { s, r };
}
beforeEach(async () => {
  await resetHarness();
  catalogue.value = {
    ready: true,
    loading: false,
    error: null,
    archives: [],
    recoveries: [],
  };
  h.open.mockResolvedValue({ key: "history" });
  vi.mocked(threads.markOpenFailed).mockClear();
});
afterEach(cleanupHarness);
it("known archive navigation retains display without opening a connection", () => {
  const { s, r } = row();
  catalogue.value.archives = [{ originalPath: cwd }];
  const before = JSON.stringify(s);
  call("ConversationLibrary", "onOpen", r);
  expect(component("ThreadPage")).toMatchObject({ viewKey: "history" });
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
  expect(JSON.stringify(s)).toBe(before);
  expect(h.draft.text).toBe("OWN-ORIGINAL-DRAFT");
});
it("cold known archived history retains identity and does not pretend to have loaded body", () => {
  const { r } = row(false);
  catalogue.value.archives = [{ originalPath: cwd }];
  call("ConversationLibrary", "onOpen", r);
  expect(h.open).not.toHaveBeenCalled();
  expect(threads.markOpenFailed).toHaveBeenCalledWith(
    "history",
    "A",
    cwd,
    "native",
    expect.any(String),
  );
  expect(h.threads.has("history")).toBe(false);
});
it.each(["notReady", "loading", "error", "unrelated"])(
  "%s catalogue keeps existing explicit navigation policy",
  (kind) => {
    const { r } = row();
    catalogue.value.archives = [
      { originalPath: kind === "unrelated" ? cwd + "-other" : cwd },
    ];
    if (kind === "notReady") catalogue.value.ready = false;
    if (kind === "loading") catalogue.value.loading = true;
    if (kind === "error") catalogue.value.error = "failed";
    call("ConversationLibrary", "onOpen", r);
    expect(h.open).toHaveBeenCalledTimes(1);
  },
);

it.each([true, false])(
  "retained recovery after cancelled deletion and archive restore does not block explicit history navigation (loaded=%s)",
  (loaded) => {
    const { s, r } = row(loaded);
    catalogue.value.archives = [{ originalPath: cwd }];
    catalogue.value.recoveries = [
      { originalPath: cwd, id: "prepared-then-cancelled" },
    ];
    call("ConversationLibrary", "onOpen", r);
    expect(h.open).not.toHaveBeenCalled();
    catalogue.value.archives = []; // Explicit archive restoration removes only this association.
    call("ConversationLibrary", "onOpen", r);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(s.cwd).toBe(cwd);
    expect(h.draft.text).toBe("OWN-ORIGINAL-DRAFT");
  },
);
