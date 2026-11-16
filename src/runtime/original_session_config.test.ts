import { afterEach, expect, it, vi } from "vitest";
import { applyConfigCheck, type ConfigCheck } from "./config_check";
import { reviewOriginalSessionConfig } from "./original_session_config";
import { SessionConfiguration } from "./session_configuration";
import { freshThreadState } from "./session_projection";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));

const target = {
  agentId: "agent",
  cwd: "/original",
  sessionId: "old-chat",
  connectionId: "the-restored-connection",
};
const choices = [
  { id: "model", category: "model", type: "select", value: "original-model" },
  {
    id: "effort",
    category: "thought_level",
    type: "select",
    value: "medium",
  },
];
const checked = {
  status: "ready",
  issues: [],
  current: { choices },
  protectedIds: choices.map(({ id }) => id),
} as const;
const review = {
  reviewId: "approved-review",
  source: "backup",
  choices: choices.map(({ id, value }) => ({
    id,
    name: id,
    value,
    label: value,
  })),
};
const options = choices.map(({ id, category, type, value }) => ({
  id,
  name: id,
  category,
  type,
  currentValue: value,
  options: [{ value, name: value }],
}));

function reopened() {
  const state = freshThreadState(
    "original",
    target.agentId,
    target.cwd,
    target.sessionId,
  );
  state.connectionId = target.connectionId;
  state.resumed = true;
  state.identity = "established";
  state.permissionState = "ready";
  state.items.push({
    kind: "agent",
    id: "historical",
    text: "restored reply",
    time: 0,
    streaming: false,
  });
  applyConfigCheck(state, {
    ...checked,
    status: "blocked",
    issues: choices.map(({ id, value, category }) => ({
      id,
      category,
      current: value,
      expected: null,
      reason: "unrecorded",
    })),
  } as ConfigCheck);
  return state;
}

afterEach(() => h.invoke.mockReset());

it("only confirms an exact complete review and preserves paused queued work", async () => {
  const state = reopened();
  state.queued = [[{ type: "text", text: "saved queue item" }]];
  const manager = new SessionConfiguration({
    thread: () => state,
    emit: vi.fn(),
    finish: vi.fn(),
    permissionRevision: () => 0,
  });
  h.invoke.mockResolvedValueOnce(review);
  expect(
    await reviewOriginalSessionConfig(state, () => true, "/backup.sqlite3"),
  ).toEqual(review);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "acp_review_original_session_config",
    { ...target, backupPath: "/backup.sqlite3" },
  );
  expect(state.modelDrift).toBe(true);

  h.invoke.mockResolvedValueOnce({
    ...checked,
    configuration: {
      configOptions: options,
      configOptionsModern: true,
      configCheck: checked,
      permissionConfigId: null,
      permissionState: "ready",
      service: null,
    },
  });
  const refresh = vi.fn().mockResolvedValue(undefined);
  expect(await manager.confirm(state.key, refresh, review.reviewId)).toBe(true);
  expect(h.invoke.mock.calls).toHaveLength(2);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "acp_confirm_original_session_config",
    {
      ...target,
      reviewId: review.reviewId,
      sameOriginalAccount: true,
    },
  );
  expect(state.configCheck?.status).toBe("ready");
  expect(state.modelDrift).toBe(false);
  expect(state.queued).toHaveLength(1);
  expect(state.queuePaused).toBe("unavailable");
  expect(refresh).toHaveBeenCalledOnce();
});

it("rejects an incomplete review and does not offer recovery for a different report", async () => {
  const state = reopened();
  h.invoke.mockResolvedValueOnce({
    ...review,
    source: "attestation",
    choices: [review.choices[0]],
  });
  await expect(
    reviewOriginalSessionConfig(state, () => true),
  ).rejects.toThrow();
  state.configCheck!.issues[0]!.reason = "changed";
  expect(await reviewOriginalSessionConfig(state, () => true)).toBeNull();
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "acp_review_original_session_config",
    target,
  );
  expect(state.modelDrift).toBe(true);
});
