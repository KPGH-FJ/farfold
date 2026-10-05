import { beforeEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ kind: "agent", ptyId: null as string | null })),
  wait: vi.fn(async () => 0),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ports.invoke,
  Channel: class {},
}));
vi.mock("./agents", () => ({
  authRun: ports.run,
  agentLogout: ports.run,
  ptyAwait: ports.wait,
  ptyClose: vi.fn(),
}));

import { beginAuthentication } from "./auth_actions";
import { authenticationActivity } from "./authentication";

beforeEach(() => vi.clearAllMocks());

it.each([
  { kind: "terminal", ptyId: "unexpected-terminal" },
  { kind: "agent", ptyId: "unexpected-terminal" },
  { kind: "unrecognized", ptyId: null },
])(
  "never treats a $kind startup reply as a confirmed protocol login",
  async (reply) => {
    ports.run.mockResolvedValueOnce(reply);
    const onChanged = vi.fn(async () => {});
    const activity = beginAuthentication({
      target: { agentId: `protocol-shape-${reply.kind}`, cwd: "/original" },
      method: { id: "reviewed-login", kind: "agent" },
      onChanged,
    });
    await vi.waitFor(() =>
      expect(activity.getSnapshot()?.phase).toBe("failed"),
    );
    expect(activity.getSnapshot()).toMatchObject({
      operationConfirmed: false,
      checked: false,
      terminal: null,
    });
    expect(ports.invoke).not.toHaveBeenCalled();
    expect(ports.wait).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  },
);

it.each([
  { kind: "agent", ptyId: null },
  { kind: "agent", ptyId: "wrong-route-terminal" },
  { kind: "terminal", ptyId: "" },
])(
  "rejects a $kind reply without the reviewed terminal instead of fabricating its exit",
  async (reply) => {
    ports.run.mockResolvedValueOnce(reply);
    const onChanged = vi.fn(async () => {});
    const activity = beginAuthentication({
      target: { agentId: `terminal-shape-${reply.kind}`, cwd: "/original" },
      method: { id: "reviewed-terminal", kind: "terminal" },
      onChanged,
    });
    await vi.waitFor(() =>
      expect(activity.getSnapshot()?.phase).toBe("failed"),
    );
    expect(activity.getSnapshot()).toMatchObject({
      operationConfirmed: false,
      checked: false,
      terminalOutcome: { kind: "failed" },
    });
    expect(ports.wait).not.toHaveBeenCalled();
    expect(ports.invoke).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  },
);

it.each(["environment", "unsupported"])(
  "never begins automatic %s authentication, even without a returned reason",
  (kind) => {
    const agentId = `declaration-${kind}`;
    expect(() =>
      beginAuthentication({
        target: { agentId, cwd: "/original" },
        method: { id: "declared", kind },
        onChanged: vi.fn(async () => {}),
      }),
    ).toThrow();
    expect(authenticationActivity(agentId).getSnapshot()).toBeNull();
    expect(ports.run).not.toHaveBeenCalled();
    expect(ports.invoke).not.toHaveBeenCalled();
  },
);

it.each(["agent", "terminal"])(
  "does not begin an unavailable %s login or invalidate its operation state",
  (kind) => {
    const agentId = `unavailable-${kind}`;
    const reason = "此登录方式的程序目标尚未确认。";
    expect(() =>
      beginAuthentication({
        target: { agentId, cwd: "/original" },
        method: { id: "login", kind, unavailableReason: reason },
        onChanged: vi.fn(async () => {}),
      }),
    ).toThrow(reason);
    expect(authenticationActivity(agentId).getSnapshot()).toBeNull();
    expect(ports.run).not.toHaveBeenCalled();
    expect(ports.invoke).not.toHaveBeenCalled();
  },
);

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
  expect(ports.invoke).toHaveBeenCalledExactlyOnceWith("auth_refresh", {
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

it("finishes account switching at confirmed logout and recheck without starting another login", async () => {
  const onChanged = vi.fn(async () => {});
  const activity = beginAuthentication({
    target: { agentId: "account-switch-success", cwd: "/original" },
    method: { id: "logout", kind: "agent" },
    logout: true,
    switchAccount: true,
    onChanged,
  });
  await vi.waitFor(() =>
    expect(activity.getSnapshot()?.phase).toBe("completed"),
  );
  expect(activity.getSnapshot()).toMatchObject({
    target: { agentId: "account-switch-success", cwd: "/original" },
    operation: { intent: "switch_account" },
    operationConfirmed: true,
    checked: true,
  });
  expect(ports.run).toHaveBeenCalledOnce();
  expect(ports.invoke).toHaveBeenCalledExactlyOnceWith("auth_recheck", {
    agentId: "account-switch-success",
    cwd: "/original",
  });
  expect(onChanged).toHaveBeenCalledOnce();
});

it("preserves a failed exit and does not recheck or start a replacement login", async () => {
  ports.run.mockRejectedValueOnce(new Error("账号退出尚未确认"));
  const onChanged = vi.fn(async () => {});
  const activity = beginAuthentication({
    target: { agentId: "account-switch-failure", cwd: "/original" },
    method: { id: "logout", kind: "agent" },
    logout: true,
    switchAccount: true,
    onChanged,
  });
  await vi.waitFor(() => expect(activity.getSnapshot()?.phase).toBe("failed"));
  expect(activity.getSnapshot()?.checked).toBe(false);
  expect(activity.getSnapshot()?.operationConfirmed).toBe(false);
  expect(ports.run).toHaveBeenCalledOnce();
  expect(ports.invoke).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
  await activity.recheck(async () => {});
  expect(activity.getSnapshot()).toMatchObject({
    phase: "completed",
    checked: true,
    operationConfirmed: false,
  });
});

it("runs a method-level key login with only its reference and revision in the protocol request", async () => {
  const activity = beginAuthentication({
    target: { agentId: "method-key-success", cwd: "/original" },
    method: {
      id: "provider-key",
      kind: "api-key",
      apiKeyProvider: "declared-provider",
    },
    credentialId: "saved-key-reference",
    credentialRevision: "selected-revision",
    onChanged: vi.fn(async () => {}),
  });
  await vi.waitFor(() =>
    expect(activity.getSnapshot()?.phase).toBe("completed"),
  );
  expect(ports.run).toHaveBeenCalledExactlyOnceWith(
    "method-key-success",
    "provider-key",
    expect.objectContaining({
      cwd: "/original",
      credentialId: "saved-key-reference",
      credentialRevision: "selected-revision",
    }),
  );
  const request = ports.run.mock.calls[0];
  expect(JSON.stringify(request)).not.toContain('"key":');
  expect(JSON.stringify(activity.getSnapshot())).not.toContain(
    "saved-key-reference",
  );
  expect(JSON.stringify(activity.getSnapshot())).not.toContain(
    "selected-revision",
  );
  expect(activity.getSnapshot()?.checked).toBe(true);
});

it.each(["missing-provider", "missing-reference", "missing-revision"])(
  "does not begin a method-level Key login with %s",
  (missing) => {
    const agentId = `key-${missing}`;
    expect(() =>
      beginAuthentication({
        target: { agentId, cwd: "/original" },
        method: {
          id: "provider-key",
          kind: "api-key",
          apiKeyProvider:
            missing === "missing-provider" ? undefined : "declared-provider",
        },
        credentialId:
          missing === "missing-reference" ? undefined : "saved-key-reference",
        credentialRevision:
          missing === "missing-revision" ? undefined : "selected-revision",
        onChanged: vi.fn(async () => {}),
      }),
    ).toThrow();
    expect(authenticationActivity(agentId).getSnapshot()).toBeNull();
    expect(ports.run).not.toHaveBeenCalled();
  },
);

it("keeps a failed method-level Key login retryable without rechecking or changing the saved reference", async () => {
  ports.run.mockRejectedValueOnce(new Error("authentication rejected"));
  const input = {
    target: { agentId: "method-key-retry", cwd: "/original" },
    method: {
      id: "provider-key",
      kind: "api-key",
      apiKeyProvider: "declared-provider",
    },
    credentialId: "saved-key-reference",
    credentialRevision: "selected-revision",
    onChanged: vi.fn(async () => {}),
  };
  const activity = beginAuthentication(input);
  await vi.waitFor(() => expect(activity.getSnapshot()?.phase).toBe("failed"));
  expect(ports.invoke).not.toHaveBeenCalled();
  beginAuthentication(input);
  await vi.waitFor(() =>
    expect(activity.getSnapshot()?.phase).toBe("completed"),
  );
  expect(ports.run).toHaveBeenCalledTimes(2);
  expect(activity.getSnapshot()?.checked).toBe(true);
});

it("uses the shared cancellation confirmation for an active method-level Key login", async () => {
  let reject!: (error: Error) => void;
  const result = new Promise<never>((_resolve, failure) => {
    reject = failure;
  });
  ports.run.mockReturnValueOnce(result);
  const activity = beginAuthentication({
    target: { agentId: "method-key-cancel", cwd: "/original" },
    method: {
      id: "provider-key",
      kind: "api-key",
      apiKeyProvider: "declared-provider",
    },
    credentialId: "saved-key-reference",
    credentialRevision: "selected-revision",
    onChanged: vi.fn(async () => {}),
  });
  await vi.waitFor(() => expect(ports.run).toHaveBeenCalledOnce());
  await activity.cancel();
  expect(activity.getSnapshot()?.phase).toBe("cancelling");
  expect(ports.invoke).toHaveBeenCalledExactlyOnceWith(
    "auth_cancel",
    expect.objectContaining({ agentId: "method-key-cancel" }),
  );
  reject(new Error("AUTH_CANCELLED"));
  await vi.waitFor(() =>
    expect(activity.getSnapshot()?.phase).toBe("cancelled"),
  );
  expect(activity.getSnapshot()?.checked).toBe(false);
});
