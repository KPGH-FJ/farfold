import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ status: "submitted" }),
}));
import { invoke } from "@tauri-apps/api/core";
import { InteractionActions } from "./interaction_actions";
import { freshThreadState } from "./session_projection";

function setup() {
  const state = freshThreadState(
    "stop-interactions",
    "agent",
    "/work",
    "native",
  );
  state.running = true;
  state.queued = [[{ type: "text", text: "Keep queue" }]];
  state.queuePaused = "stopped";
  state.pendingPermissions = [
    {
      requestId: "permission",
      status: "pending",
      error: null,
      toolCallId: "tool",
      title: "Original command",
      kind: "execute",
      locations: [],
      decision: null,
      options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
    },
  ];
  state.pendingElicitations = [
    {
      requestId: "question",
      status: "pending",
      error: null,
      toolCallId: null,
      message: "Original question",
      schema: null,
      values: { answer: "Keep answer" },
    },
  ];
  const actions = new InteractionActions(
    (key) => (key === state.key ? state : undefined),
    vi.fn(),
  );
  return { state, actions };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("blocks new decisions only while waiting for stop and preserves the original requests for unknown recovery", async () => {
  vi.useFakeTimers();
  const { state, actions } = setup();
  const permission = state.pendingPermissions[0];
  const question = state.pendingElicitations[0];
  state.stopping = true;
  actions.decide(state.key, "permission", "once", "Allow", true);
  await actions.respondElicitation(
    state.key,
    "question",
    "accept",
    question.values,
  );
  await vi.runAllTimersAsync();
  expect(invoke).not.toHaveBeenCalled();
  expect(permission.decision).toBeNull();
  expect(state.pendingElicitations[0]).toBe(question);
  expect(question.values).toEqual({ answer: "Keep answer" });
  state.stopping = false;
  state.stopUnconfirmed = true;
  actions.decide(state.key, "permission", "once", "Allow", true);
  await actions.respondElicitation(state.key, "question", "cancel");
  await vi.runAllTimersAsync();
  expect(invoke).toHaveBeenCalledWith("session_permission_respond", {
    sessionId: "native",
    requestId: "permission",
    optionId: "once",
  });
  expect(invoke).toHaveBeenCalledWith("session_elicitation_respond", {
    sessionId: "native",
    requestId: "question",
    action: "cancel",
    content: null,
  });
  expect(state.stopUnconfirmed).toBe(true);
  expect(state.queuePaused).toBe("stopped");
  expect(state.queued).toEqual([[{ type: "text", text: "Keep queue" }]]);
});

it("does not dispatch a remembered approval whose undo period ends during stop confirmation", async () => {
  vi.useFakeTimers();
  const { state, actions } = setup();
  actions.decide(state.key, "permission", "once", "Allow", true, true);
  expect(state.pendingPermissions[0].decision).not.toBeNull();
  state.stopping = true;
  await vi.runAllTimersAsync();
  expect(invoke).not.toHaveBeenCalled();
  expect(state.pendingPermissions[0].status).toBe("pending");
  expect(state.pendingPermissions[0].decision).toBeNull();
  state.stopping = false;
  await vi.runAllTimersAsync();
  expect(invoke).not.toHaveBeenCalled();
});

it("retains ordinary approval and answer operations while future sends are paused", async () => {
  vi.useFakeTimers();
  const { state, actions } = setup();
  state.workEnabled = false;
  actions.decide(state.key, "permission", "once", "Allow", true);
  await actions.respondElicitation(state.key, "question", "accept", {
    answer: "Keep answer",
  });
  await vi.runAllTimersAsync();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(state.queued).toHaveLength(1);
});
