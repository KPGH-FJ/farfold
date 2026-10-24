import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emitOpeningHeader } from "./session_open_test_fixture";
import type { ConfigCheck } from "./config_check";
import type { PromptBlock, ThreadState } from "./session_types";

interface OpenWire {
  cwd: string;
  nativeSessionId: string;
  openToken: string;
  channel: { onmessage(event: unknown): void };
}
interface PromptWire {
  content: PromptBlock[];
  admissionChannel: { onmessage(event: unknown): void };
}
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  opened: null as OpenWire | null,
  prompts: [] as PromptWire[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

const originalModel = "owned-original";
const changedModel = "owned-explicit-choice";
const nextInput: PromptBlock[] = [
  { type: "text", text: "Owned explicitly queued input" },
];
const options = (value: string) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: value,
    options: [
      { value: originalModel, name: "Original" },
      { value: changedModel, name: "Explicit choice" },
    ],
  },
];
function ready(value: string): ConfigCheck {
  return {
    status: "ready",
    protectedIds: ["model"],
    issues: [],
    current: {
      choices: [{ id: "model", category: "model", type: "select", value }],
    },
  };
}
function blocked(value: string): ConfigCheck {
  return {
    ...ready(value),
    status: "blocked",
    issues: [
      {
        id: "model",
        category: "model",
        reason: "changed",
        expected: "owned-earlier-choice",
        current: value,
      },
    ],
  };
}

type Runtime = {
  threads: typeof import("./sessions").threads;
  drafts: typeof import("./drafts");
};
let runtime: Runtime | undefined;
beforeEach(() => {
  vi.resetModules();
  h.opened = null;
  h.prompts = [];
  runtime = undefined;
  h.invoke.mockReset().mockImplementation(async (command: string, args) => {
    if (command === "session_open") {
      const wire = args as OpenWire;
      h.opened = wire;
      const result = {
        cwd: wire.cwd,
        nativeSessionId: wire.nativeSessionId,
        connectionId: "owned-history-connection",
        resumed: true,
        configOptions: options(originalModel),
        configOptionsModern: true,
        configCheck: ready(originalModel),
        service: null,
        permissionConfigId: null,
        permissionState: "ready",
      };
      emitOpeningHeader(wire, result);
      wire.channel.onmessage({
        kind: "configCheck",
        check: blocked(originalModel),
      });
      wire.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Owned retained history" },
        },
      });
      wire.channel.onmessage({
        kind: "configCheck",
        check: ready(originalModel),
      });
      wire.channel.onmessage({
        kind: "session_history_complete",
        openToken: wire.openToken,
      });
      return result;
    }
    if (command === "session_set_config") {
      expect(args.configId).toBe("model");
      expect(args.value).toBe(changedModel);
      return {
        configOptions: options(changedModel),
        configOptionsModern: true,
        configCheck: ready(changedModel),
        service: null,
        permissionConfigId: null,
        permissionState: "ready",
      };
    }
    if (command === "session_prompt") {
      const wire = args as PromptWire;
      h.prompts.push(wire);
      wire.admissionChannel.onmessage({
        receiptId: h.prompts.length,
        phase: "offered",
      });
      return { status: "accepted" };
    }
    return command === "session_index_list" ? [] : null;
  });
});
afterEach(async () => {
  await runtime?.drafts.draftPersistence.flush();
});

async function openAndChange(): Promise<Runtime & { state: ThreadState }> {
  const drafts = await import("./drafts");
  await drafts.draftPersistence.load();
  const threads = (await import("./sessions")).threads;
  runtime = { threads, drafts };
  const state = await threads.open({
    agentId: "owned-config-pause",
    cwd: "/owned-config-pause",
    nativeSessionId: "owned-history",
    service: null,
  });
  expect(state.resumed).toBe(true);
  expect(state.identity).toBe("established");
  expect(state.configCheck).toEqual(ready(originalModel));
  expect(state.modelDrift).toBe(false);
  expect(state.openError).toBeNull();
  expect(state.connectionOutcomeUnknown).toBe(false);
  expect(state.queued).toEqual([]);
  expect(state.queuePaused).toBe("unavailable");
  const { ownsConfigurationPause } = await import("./configuration_pause");
  expect(ownsConfigurationPause(state)).toBe(true);
  await threads.setConfig(state.key, "model", changedModel);
  expect(state.configCheck).toEqual(ready(changedModel));
  expect(state.configOptions[0].currentValue).toBe(changedModel);
  expect(state.configuring).toBe(false);
  expect(state.configError).toBeNull();
  expect(state.queued).toEqual([]);
  expect(state.queuePaused).toBe("unavailable");
  expect(ownsConfigurationPause(state)).toBe(true);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "session_open"),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "session_set_config"),
  ).toHaveLength(1);
  expect(h.prompts).toEqual([]);
  return { threads, drafts, state };
}

it("keeps a replay-owned empty configuration pause after a matching setter and dispatches the new input only after explicit continue", async () => {
  const { threads, state } = await openAndChange();
  const { canReleaseEmptyQueuePause } = await import("./queue");
  expect(canReleaseEmptyQueuePause(state)).toBe(false);
  expect(await threads.send(state.key, nextInput)).toEqual({
    status: "queued",
  });
  expect(state.queued).toEqual([nextInput]);
  expect(state.queuePaused).toBe("unavailable");
  expect(h.prompts).toEqual([]);
  await threads.continueQueue(state.key);
  expect(h.prompts).toHaveLength(1);
  expect(h.prompts[0].content).toEqual(nextInput);
  expect(state.queued).toEqual([]);
  expect(state.queuePaused).toBeNull();
  // Repeated Continue with no queue cannot dispatch a second request.
  await threads.continueQueue(state.key);
  expect(h.prompts).toHaveLength(1);
});

it.each([
  "current-unknown",
  "unconfirmed-stop",
  "permission-required",
  "config-blocked",
] as const)(
  "does not dispatch the queued input when %s blocks explicit continue",
  async (condition) => {
    const { threads, state } = await openAndChange();
    // These two finite flags are explicit guard preconditions, not a claim
    // about which event caused the separately observed live application state.
    if (condition === "current-unknown") state.connectionOutcomeUnknown = true;
    else if (condition === "unconfirmed-stop") state.stopUnconfirmed = true;
    else if (condition === "permission-required")
      h.opened!.channel.onmessage({
        kind: "permissionState",
        permissionConfigId: "owned-permission",
        permissionState: "required",
      });
    else
      h.opened!.channel.onmessage({
        kind: "configCheck",
        check: blocked(changedModel),
      });
    expect(await threads.send(state.key, nextInput)).toEqual({
      status: "queued",
    });
    const queue = state.queued;
    const pause = state.queuePaused;
    await threads.continueQueue(state.key);
    expect(h.prompts).toEqual([]);
    expect(state.queued).toBe(queue);
    expect(state.queued).toEqual([nextInput]);
    expect(state.queuePaused).toBe(pause);
    if (condition === "current-unknown")
      expect(state.connectionOutcomeUnknown).toBe(true);
    if (condition === "unconfirmed-stop")
      expect(state.stopUnconfirmed).toBe(true);
    if (condition === "permission-required")
      expect(state.permissionState).toBe("required");
    if (condition === "config-blocked") expect(state.modelDrift).toBe(true);
  },
);
