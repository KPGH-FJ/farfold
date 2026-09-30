import { beforeEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ kind: "agent" })),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ports.invoke,
  Channel: class {},
}));
vi.mock("./agents", () => ({
  authRun: ports.run,
  agentLogout: ports.run,
  ptyAwait: vi.fn(),
  ptyClose: vi.fn(),
}));

import { beginAuthentication } from "./auth_actions";

beforeEach(() => vi.clearAllMocks());

it("checks only the original account connection after login, without disconnecting the whole Agent", async () => {
  const onChanged = vi.fn(async () => {});
  const activity = beginAuthentication({
    target: { agentId: "auth-scope-success", cwd: "/original" },
    method: { id: "login", kind: "agent" },
    onChanged,
  });
  await vi.waitFor(() =>
    expect(activity.getSnapshot()?.phase).toBe("completed"),
  );
  expect(ports.invoke).toHaveBeenCalledExactlyOnceWith("auth_recheck", {
    agentId: "auth-scope-success",
    cwd: "/original",
  });
  expect(onChanged).toHaveBeenCalledOnce();
  expect(activity.getSnapshot()?.checked).toBe(true);
});

it("keeps login completed but unchecked if the original directory has acquired work", async () => {
  ports.invoke.mockRejectedValueOnce(new Error("请先完成此目录的工作"));
  const onChanged = vi.fn(async () => {});
  const activity = beginAuthentication({
    target: { agentId: "auth-scope-busy", cwd: "/original" },
    method: { id: "login", kind: "agent" },
    onChanged,
  });
  await vi.waitFor(() =>
    expect(activity.getSnapshot()?.phase).toBe("completed"),
  );
  expect(activity.getSnapshot()?.checked).toBe(false);
  expect(onChanged).not.toHaveBeenCalled();
  expect(ports.invoke.mock.calls).toHaveLength(1);
});
