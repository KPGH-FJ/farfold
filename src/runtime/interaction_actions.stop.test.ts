import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ status: "submitted" }),
  Channel: class {},
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// ThreadView's unrelated diagnostic origin read is outside this interaction test.
vi.mock("./performance-trace", () => ({ traceAfterPaint: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InteractionActions } from "./interaction_actions";
import { freshThreadState } from "./session_projection";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElicitationCard } from "../components/ElicitationCard";
import { ThreadView } from "../components/ThreadView";
import { STRINGS } from "./strings";

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

it.each([
  ["form", "decline"],
  ["form", "cancel"],
  ["url", "decline"],
  ["url", "cancel"],
] as const)(
  "allows an explicit %s inquiry %s after stop becomes unknown without resuming work",
  async (mode, action) => {
    const { state, actions } = setup();
    const question = state.pendingElicitations[0];
    question.mode = mode;
    if (mode === "url") question.url = "https://example.test/controlled";
    state.stopUnconfirmed = true;
    await actions.respondElicitation(state.key, question.requestId, action);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "session_elicitation_respond",
      {
        sessionId: "native",
        requestId: "question",
        action,
        content: null,
      },
    );
    expect(openUrl).not.toHaveBeenCalled();
    expect(state.pendingElicitations).toEqual([]);
    expect(question.values).toEqual({ answer: "Keep answer" });
    expect(state.running).toBe(true);
    expect(state.stopUnconfirmed).toBe(true);
    expect(state.queuePaused).toBe("stopped");
    expect(state.queued).toEqual([[{ type: "text", text: "Keep queue" }]]);
    await actions.respondElicitation(state.key, question.requestId, action);
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);

it.each(["form", "url"] as const)(
  "still blocks %s acceptance after stop becomes unknown",
  async (mode) => {
    const { state, actions } = setup();
    const question = state.pendingElicitations[0];
    question.mode = mode;
    if (mode === "url") question.url = "https://example.test/controlled";
    state.stopUnconfirmed = true;
    await actions.respondElicitation(
      state.key,
      question.requestId,
      "accept",
      question.values,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(question.status).toBe("pending");
    expect(question.values).toEqual({ answer: "Keep answer" });
  },
);

it.each(["submitting", "uncertain"] as const)(
  "does not send another cancel for an inquiry whose answer is %s",
  async (status) => {
    const { state, actions } = setup();
    state.stopUnconfirmed = true;
    const question = state.pendingElicitations[0];
    question.status = status;
    await actions.respondElicitation(state.key, question.requestId, "cancel");
    expect(invoke).not.toHaveBeenCalled();
    expect(state.pendingElicitations[0]).toBe(question);
  },
);

it("does not accept a late URL opener result after stopping becomes unknown", async () => {
  const { state, actions } = setup();
  const question = state.pendingElicitations[0];
  question.mode = "url";
  question.url = "https://example.test/controlled";
  let opened!: () => void;
  vi.mocked(openUrl).mockImplementationOnce(
    () => new Promise<void>((resolve) => (opened = resolve)),
  );
  const answer = actions.respondElicitation(
    state.key,
    question.requestId,
    "accept",
  );
  expect(openUrl).toHaveBeenCalledOnce();
  state.stopping = true;
  await actions.respondElicitation(state.key, question.requestId, "cancel");
  expect(invoke).not.toHaveBeenCalled();
  state.stopping = false;
  state.stopUnconfirmed = true;
  opened();
  await answer;
  expect(invoke).not.toHaveBeenCalled();
  expect(state.pendingElicitations[0]).toBe(question);
});

it.each(["form", "url"] as const)(
  "keeps explicit negative actions reachable for %s while acceptance is disabled",
  (mode) => {
    const { state } = setup();
    const question = state.pendingElicitations[0];
    question.mode = mode;
    if (mode === "url") question.url = "https://example.test/controlled";
    const card = (disabled: boolean) =>
      renderToStaticMarkup(
        createElement(ElicitationCard, {
          request: question,
          disabled,
          acceptanceDisabled: true,
          onChange: () => {},
          onRespond: () => {},
        }),
      );
    const unknown = card(false);
    expect(unknown.match(/<button[^>]*disabled=""/g) ?? []).toHaveLength(1);
    expect(unknown).toMatch(/<button(?![^>]*disabled)[^>]*>拒绝<\/button>/);
    expect(unknown).toMatch(/<button(?![^>]*disabled)[^>]*>取消<\/button>/);
    if (mode === "form") expect(unknown).toMatch(/<fieldset[^>]*disabled=""/);
    expect(card(true).match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  },
);

it.each(["form", "url"] as const)(
  "wires the actual conversation %s card to negative recovery only while stop is unknown",
  (mode) => {
    const { state } = setup();
    const question = state.pendingElicitations[0];
    question.mode = mode;
    if (mode === "url") question.url = "https://example.test/controlled";
    state.stopUnconfirmed = true;
    const buttons = () => {
      const html = renderToStaticMarkup(
        createElement(ThreadView, {
          thread: state,
          active: true,
          agents: [],
          onGoSettings: () => {},
          onOpened: () => {},
        }),
      );
      return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    };
    const accepted = mode === "url" ? "同意并打开" : STRINGS.elicitation.submit;
    let rendered = buttons();
    expect(rendered.find((b) => b[2] === accepted)?.[1]).toContain("disabled");
    for (const label of ["拒绝", "取消"]) {
      const button = rendered.find((b) => b[2] === label);
      expect(button).toBeDefined();
      expect(button![1]).not.toContain("disabled");
    }
    state.stopping = true;
    rendered = buttons();
    for (const label of [accepted, "拒绝", "取消"])
      expect(rendered.find((b) => b[2] === label)?.[1]).toContain("disabled");
    expect(invoke).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  },
);
