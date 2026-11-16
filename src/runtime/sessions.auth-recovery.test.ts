import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));

import { threads } from "./sessions";
import { AgentPreparation } from "./agent_preparation";
import {
  authenticationRequired,
  beginProgramAuthenticationChange,
  captureProgramAuthentication,
  observeAuthentication,
  programAuthenticationChanged,
  useAuthentication,
} from "./authentication";
import { recheckAuthentication } from "./auth_actions";
import { draftPersistence } from "./drafts";
import { emitOpeningHeader } from "./session_open_test_fixture";

afterEach(async () => {
  await draftPersistence.flush();
  vi.restoreAllMocks();
});

it("opens a new session only after the selected program's receipt and records that program's own auth error", async () => {
  h.invoke.mockClear();
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "settings_get")
      return args?.key === "autoArchiveDays" ? 30 : null;
    if (command === "session_open") throw new Error("AUTH_REQUIRED");
    return [];
  });
  const agentId = "program-replacement-open";
  const cwd = "/during-selection";
  const old = captureProgramAuthentication(agentId);
  old.observe(cwd, "AUTH_REQUIRED");
  const finish = beginProgramAuthenticationChange(agentId);
  const opening = threads.open({ agentId, cwd });
  expect(h.invoke).not.toHaveBeenCalledWith("session_open", expect.anything());
  programAuthenticationChanged(agentId);
  finish();
  await expect(opening).rejects.toThrow("AUTH_REQUIRED");
  expect(h.invoke).toHaveBeenCalledWith(
    "session_open",
    expect.objectContaining({ agentId, cwd }),
  );
  old.observe(cwd);
  expect(authenticationRequired(useAuthentication(), agentId, cwd)).toBe(true);
});

it("clears a login requirement only after explicit preparation gets a successful fresh session response", async () => {
  h.invoke.mockClear();
  let authenticated = false;
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "settings_get")
      return args?.key === "autoArchiveDays" ? 30 : null;
    if (command === "auth_recheck") return { state: "ready" };
    if (command === "session_open") {
      if (!authenticated) throw new Error("AUTH_REQUIRED");
      const result = {
        cwd: "/account",
        nativeSessionId: "models-after-login",
        connectionId: "connection-models-after-login",
        resumed: false,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "declared-model",
            options: [{ value: "declared-model", name: "Declared model" }],
          },
        ],
      };
      emitOpeningHeader(args, result);
      return result;
    }
    return [];
  });
  const input = {
    agentId: "login-read-recovery",
    agentName: "Example",
    cwd: "/account",
    program: "same-program",
    service: null,
  };
  const controller = new AgentPreparation(threads, () => "auth-model-read");
  const required = (cwd = input.cwd, source?: string) =>
    authenticationRequired(useAuthentication(), input.agentId, cwd, source);
  observeAuthentication(input.agentId, "/other", "AUTH_REQUIRED");
  observeAuthentication(
    input.agentId,
    input.cwd,
    "AUTH_REQUIRED",
    "api-source",
  );

  await controller.prepare(input);
  expect(controller.getSnapshot().phase).toBe("failed");
  expect(required()).toBe(true);

  await recheckAuthentication(
    { agentId: input.agentId, cwd: input.cwd },
    async () => {},
  );
  expect(required()).toBe(true);
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_open"),
  ).toHaveLength(1);

  await controller.prepare(input, true);
  expect(controller.getSnapshot().phase).toBe("failed");
  expect(required()).toBe(true);

  authenticated = true;
  await controller.prepare(input, true);
  expect(required()).toBe(false);
  expect(required("/other")).toBe(true);
  expect(required(input.cwd, "api-source")).toBe(true);
  expect(controller.getSnapshot().phase).toBe("untested");
  expect(controller.getSnapshot().config).toEqual({ model: "declared-model" });
  expect(threads.thread(controller.getSnapshot().threadKey!)?.identity).toBe(
    "draft",
  );
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_open"),
  ).toHaveLength(3);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("does not clear a real request's login failure when an unauthenticated Agent still returns model options", async () => {
  h.invoke.mockClear();
  let promptFails = true;
  let sequence = 0;
  const channels = new Map<string, { onmessage: (event: unknown) => void }>();
  const processEnds = new Map<
    string,
    { onmessage: (event: unknown) => void }
  >();
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "settings_get")
      return args?.key === "autoArchiveDays" ? 30 : null;
    if (command === "session_open") {
      const id = `unauthenticated-models-${++sequence}`;
      channels.set(id, args.channel);
      processEnds.set(id, args.processEndedChannel);
      const result = {
        cwd: args.cwd,
        nativeSessionId: id,
        connectionId: `connection-${id}`,
        configCheck: { status: "ready", issues: [], current: { choices: [] } },
        resumed: false,
        configOptions: [],
      };
      emitOpeningHeader(args, result);
      return result;
    }
    if (command === "session_prompt") {
      const receiptId = sequence;
      args.admissionChannel.onmessage({ receiptId, phase: "offered" });
      const channel = channels.get(args.sessionId)!;
      if (!promptFails)
        channel.onmessage({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "FARFOLD-request-layer" },
          },
        });
      channel.onmessage({
        kind: "turnEnd",
        promptReceiptId: receiptId,
        ...(promptFails
          ? { error: "AUTH_REQUIRED" }
          : { stopReason: "end_turn" }),
      });
      return { status: "accepted" };
    }
    return [];
  });
  const input = {
    agentId: "request-login-recovery",
    agentName: "Example",
    cwd: "/request-account",
    program: "same-program",
    service: null,
  };
  const controller = new AgentPreparation(threads, () => "request-layer");
  const required = (cwd = input.cwd, source?: string) =>
    authenticationRequired(useAuthentication(), input.agentId, cwd, source);
  await controller.prepare(input);
  await controller.start();
  expect(controller.getSnapshot().phase).toBe("failed");
  expect(required()).toBe(true);
  const first = threads.thread(controller.getSnapshot().threadKey!)!;
  const history = [...first.items];
  expect(first.running).toBe(false); // the late admission ACK must not restart the round
  expect(first.connectionOutcomeUnknown).toBe(true);
  await controller.prepare(input, true);
  expect(controller.getSnapshot().threadKey).toBe(first.key);
  await expect(
    controller.prepareForAccount({ agentId: input.agentId, cwd: input.cwd }),
  ).rejects.toBeTruthy();
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_open"),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "auth_recheck"),
  ).toHaveLength(0);
  // Ordinary loss is still unknown; only the independent local receipt proves
  // that the exact process ended. The failed request itself is not repaired.
  channels.get(first.nativeSessionId)!.onmessage({ kind: "connectionLost" });
  expect(controller.canPrepare()).toBe(false);
  processEnds
    .get(first.nativeSessionId)!
    .onmessage({ connectionId: first.connectionId, closeReason: "unexpected" });
  expect(first.connectionOutcomeUnknown).toBe(true);
  expect(first.items).toEqual(history);

  await recheckAuthentication(
    { agentId: input.agentId, cwd: input.cwd },
    async () => {},
  );
  await controller.prepare(input, true);
  expect(controller.getSnapshot().phase).toBe("untested");
  expect(required()).toBe(true);
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(1);

  await controller.start();
  expect(required()).toBe(true);
  expect(controller.getSnapshot().phase).toBe("failed");
  observeAuthentication(input.agentId, "/other-request", "AUTH_REQUIRED");
  observeAuthentication(
    input.agentId,
    input.cwd,
    "AUTH_REQUIRED",
    "other-service",
  );
  const second = threads.thread(controller.getSnapshot().threadKey!)!;
  processEnds.get(second.nativeSessionId)!.onmessage({
    connectionId: second.connectionId,
    closeReason: "unexpected",
  });
  expect(second.connectionOutcomeUnknown).toBe(true);
  await controller.prepare(input, true);
  expect(required()).toBe(true);
  expect(threads.thread(first.key)).toBe(first);
  expect(first.connectionOutcomeUnknown).toBe(true);
  promptFails = false;
  await controller.start();
  expect(controller.getSnapshot().phase).toBe("passed");
  expect(required()).toBe(false);
  expect(required("/other-request")).toBe(true);
  expect(required(input.cwd, "other-service")).toBe(true);
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(3);
});
