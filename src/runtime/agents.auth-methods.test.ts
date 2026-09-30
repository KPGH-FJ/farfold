import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./sessions", () => ({ threads: {} }));
import { authMethods } from "./agents";

beforeEach(() => h.invoke.mockReset());

it("passes the exact account directory/source without selecting or connecting anything", async () => {
  const methods = {
    methods: [
      {
        id: "environment",
        name: "Environment settings",
        kind: "environment",
        envNames: ["PUBLIC_PROVIDER_KEY"],
        unavailableReason: "此账号方式暂不能自动执行。",
      },
    ],
    canLogout: false,
  };
  h.invoke.mockResolvedValueOnce(methods);
  expect(
    await authMethods("registered", { cwd: "/draft", source: "api-choice" }),
  ).toBe(methods);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("auth_methods", {
    agentId: "registered",
    cwd: "/draft",
    source: "api-choice",
  });
});

it("keeps the no-target call display-only by passing nulls rather than picking a directory", async () => {
  await authMethods("registered");
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("auth_methods", {
    agentId: "registered",
    cwd: null,
    source: null,
  });
});
