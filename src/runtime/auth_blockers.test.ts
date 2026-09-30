import { expect, it } from "vitest";
import {
  authenticationCheckBlockers,
  authenticationWorkBlockers,
} from "./auth_blockers";
import { AUTH_ACTIVITY_STRINGS as S } from "./auth_strings";
import { freshThreadState } from "./session_projection";
import type { ThreadState } from "./session_types";

it.each([
  [{ running: true }, S.workRunning],
  [{ activeToolCallIds: ["live-tool"] }, S.workTools],
  [{ stopping: true }, S.workStopping],
  [{ stopUnconfirmed: true }, S.workUnknown],
  [{ permissionState: "unknown" }, S.workUnknown],
  [{ connectionOutcomeUnknown: true }, S.workUnknown],
  [{ uncertainPrompt: [{ type: "text", text: "pending" }] }, S.workUnknown],
  [{ submitting: true }, S.workSending],
  [{ reconnecting: true }, S.workConnecting],
  [{ configuring: true }, S.workChanging],
  [{ pendingPermissions: [{}] }, S.workDecision],
  [{ pendingElicitations: [{}] }, S.workDecision],
] as [Partial<ThreadState>, string][])(
  "lists the observed account-operation blocker %j",
  (patch, reason) => {
    const state = freshThreadState("work", "agent-a", "/work", "native");
    Object.assign(state, patch, { identity: "established", title: "Own work" });
    expect(authenticationWorkBlockers("agent-a", [state])).toEqual([
      { key: "work", title: "Own work", reason, canOpen: true },
    ]);
    expect(authenticationWorkBlockers("other-agent", [state])).toEqual([]);
  },
);

it("keeps an unfinished API task protected from account mutations with unknown shared effects", () => {
  const state = freshThreadState("api-work", "agent-a", "/elsewhere", "native");
  Object.assign(state, {
    service: { id: "api", model: "model", fingerprint: "own" },
    serviceContext: "api-revision",
    running: true,
  });
  expect(authenticationWorkBlockers("agent-a", [state])).toHaveLength(1);
  expect(
    authenticationCheckBlockers({ agentId: "agent-a", cwd: "/elsewhere" }, [
      state,
    ]),
  ).toEqual([]);
  expect(
    authenticationCheckBlockers(
      { agentId: "agent-a", cwd: "/elsewhere", source: "api-revision" },
      [state],
    ),
  ).toHaveLength(1);
});

it("does not treat idle drafts, paused queues or history awaiting restoration as active work", () => {
  const draft = freshThreadState("draft", "agent-a", "/work", "native");
  draft.queued = [[{ type: "text", text: "unsent" }]];
  draft.queuePaused = "stopped";
  draft.permissionState = "required";
  const history = freshThreadState("old", "agent-a", "/work", "old");
  Object.assign(history, {
    identity: "established",
    connectionLost: true,
    activeToolCallIds: ["old-tool"],
    openError: "等待恢复",
  });
  expect(authenticationWorkBlockers("agent-a", [draft, history])).toEqual([]);
});

it("keeps an unadmitted draft outcome visible without presenting a successful conversation", () => {
  const draft = freshThreadState("draft", "agent-a", "/work", "native");
  draft.identity = "draft";
  draft.connectionOutcomeUnknown = true;
  expect(authenticationWorkBlockers("agent-a", [draft])).toEqual([
    {
      key: "draft",
      title: S.workUntitled,
      reason: S.workUnknown,
      canOpen: false,
    },
  ]);
});
