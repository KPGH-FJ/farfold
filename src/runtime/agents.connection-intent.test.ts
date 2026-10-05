import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { agentConnect, agentDisconnect } from "./agents";
import {
  allowAutomaticConnection,
  isAutomaticConnectionAllowed,
} from "./connection_intent";

afterEach(() => {
  allowAutomaticConnection("intent-api");
  h.invoke.mockReset();
});

it("blocks incidental opens before the disconnect response arrives", async () => {
  let finish!: (value: boolean) => void;
  h.invoke.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const disconnecting = agentDisconnect("intent-api");
  expect(isAutomaticConnectionAllowed("intent-api")).toBe(false);
  finish(true);
  await disconnecting;
  expect(isAutomaticConnectionAllowed("intent-api")).toBe(false);
});

it("does not let a late connect response undo a later disconnect", async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation((command) =>
    command === "agent_connect"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(true),
  );
  const connecting = agentConnect("intent-api", "/p");
  await agentDisconnect("intent-api");
  finish({ agentId: "intent-api", cwd: "/p", state: "ready" });
  await connecting;
  expect(isAutomaticConnectionAllowed("intent-api")).toBe(false);
});

it("restores the previous intent when disconnect fails", async () => {
  h.invoke.mockRejectedValue(new Error("Still working"));
  await expect(agentDisconnect("intent-api")).rejects.toThrow("Still working");
  expect(isAutomaticConnectionAllowed("intent-api")).toBe(true);
});
