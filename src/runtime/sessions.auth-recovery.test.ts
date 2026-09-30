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
  observeAuthentication,
  useAuthentication,
} from "./authentication";
import { recheckAuthentication } from "./auth_actions";
import { draftPersistence } from "./drafts";

afterEach(async () => {
  await draftPersistence.flush();
  vi.restoreAllMocks();
});

it("clears a login requirement only after explicit preparation gets a successful fresh session response", async () => {
  let authenticated = false;
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "settings_get")
      return args?.key === "autoArchiveDays" ? 30 : null;
    if (command === "auth_recheck") return { state: "ready" };
    if (command === "session_open") {
      if (!authenticated) throw new Error("AUTH_REQUIRED");
      return {
        cwd: "/account",
        nativeSessionId: "models-after-login",
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
