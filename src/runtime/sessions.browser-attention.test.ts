import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { threads, hasPendingRequests, type IndexRow } from "./sessions";
import {
  BrowserSharingController,
  type BrowserShareInfo,
} from "./browser_sharing";
import { canDrain } from "./queue";
import { groupSidebarRows } from "./sidebar";
import { applyConnectionLost } from "./session_projection";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
function setup(id: string) {
  const key = `browser-attention:${id}`;
  const state = threads.markOpenFailed(
    key,
    "agent",
    "/synthetic",
    id,
    "fixture",
  );
  state.openError = null;
  state.connectionLost = false;
  state.identity = "established";
  state.workEnabled = true;
  state.queued = [[{ type: "text", text: "Unsent synthetic work" }]];
  const scope = {
    taskKey: key,
    target: { agentId: "agent", cwd: "/synthetic", nativeSessionId: id },
  };
  let info: BrowserShareInfo = {
    taskKey: key,
    agentId: "agent",
    label: "page",
    phase: "unshared",
    revision: 1,
    reason: null,
    pendingRequest: {
      taskKey: key,
      requestId: `read:${id}`,
      label: "page",
      url: "https://example.org/",
      pageRevision: 1,
      phase: "awaiting_permission",
    },
  };
  const controller = new BrowserSharingController(
    {
      status: async () => info,
      respond: async () =>
        (info = { ...info, revision: info.revision + 1, pendingRequest: null }),
      allow: vi.fn(),
      stop: vi.fn(),
      listenChanged: async () => () => {},
    },
    scope,
  );
  const row: IndexRow = {
    id: key,
    agentId: "agent",
    cwd: "/synthetic",
    nativeSessionId: id,
    title: "Synthetic",
    configOptions: null,
    pinned: false,
    archived: false,
    updatedAt: 1,
    createdAt: 1,
  };
  cleanups.push(() => {
    controller.dispose();
    void threads.close(key);
  });
  return {
    state,
    controller,
    row,
    scope,
    info,
    setInfo: (next: BrowserShareInfo) => {
      info = next;
    },
  };
}

it("routes a real browser pending receipt into existing attention, sidebar and queue guards, then clears on cancellation", async () => {
  const { state, controller, row, info } = setup("pending");
  const changed = vi.fn();
  cleanups.push(threads.subscribe(changed));
  expect(canDrain(state)).toBe(true);
  await controller.start();
  expect(hasPendingRequests(state)).toBe(true);
  expect(threads.needsAttention(state)).toBe(true);
  expect(canDrain(state)).toBe(false);
  const grouped = () =>
    groupSidebarRows([row], new Map([[state.key, state]]), {
      attentionOnly: true,
    });
  expect(grouped()[0].rows[0].status).toBe("need");
  expect(changed).toHaveBeenCalled();
  await controller.respond(info.pendingRequest!.requestId, false);
  expect(hasPendingRequests(state)).toBe(false);
  expect(threads.needsAttention(state)).toBe(false);
  expect(grouped()).toEqual([]);
  expect(canDrain(state)).toBe(true);
});

it("drops the decision at disconnect and does not resurrect it from a late status or mutate another task", async () => {
  const first = setup("old");
  const other = setup("other");
  await first.controller.start();
  expect(first.state.browserReadRequestId).toBe("read:old");
  expect(other.state.browserReadRequestId).toBeUndefined();
  applyConnectionLost(first.state);
  expect(hasPendingRequests(first.state)).toBe(false);
  expect(first.state.connectionOutcomeUnknown).toBe(true);
  first.setInfo({
    ...first.info,
    revision: 2,
    pendingRequest: { ...first.info.pendingRequest!, requestId: "late" },
  });
  await first.controller.refresh();
  expect(first.state.browserReadRequestId).toBeNull();
  expect(other.state.browserReadRequestId).toBeUndefined();
  await threads.close(first.state.key);
  first.setInfo({ ...first.info, revision: 3 });
  await first.controller.refresh();
  expect(threads.thread(first.state.key)).toBeUndefined();
});
