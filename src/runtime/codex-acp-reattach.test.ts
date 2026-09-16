import { expect, it, vi } from "vitest";
import {
  CodexConfigurePrivateView,
  checkedCodexConfigureDiscovery,
} from "./codex-acp-configure";
import type { CodexAcpScope } from "./codex-acp-contract";
const scope: CodexAcpScope = {
  runtimeProductId: "codex",
  installationId: "i",
  runtimeBuildId: "b",
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "a",
  connectionId: "c",
  profileId: "p",
  generation: 1,
};
const operation = {
  kind: "device",
  operationId: 7,
  loginId: "login-7",
  phase: "waiting",
  inFlight: false,
};
const discovery = (op: unknown = operation) => ({
  kind: "configure_discovery",
  discovery: { scope, operation: op },
});
const fresh = (phase = "waiting") => ({
  kind: "configure",
  snapshot: {
    scope,
    operationId: 7,
    loginId: "login-7",
    phase,
    accountState: phase === "confirmed" ? "chatgpt" : "unconfirmed",
    credentialState: phase === "confirmed" ? "committed" : "not_attempted",
    payload:
      phase === "waiting"
        ? {
            type: "device",
            verificationUrl: "https://auth.openai.com/device",
            userCode: "FRESH-CODE",
          }
        : null,
  },
});
function setup() {
  const discover = vi.fn().mockResolvedValue(discovery(null));
  const request = vi.fn().mockResolvedValue(fresh());
  let current = true;
  const view = new CodexConfigurePrivateView(scope, () => ({
    allowed: true,
    current: () => current,
    discover,
    request,
  }));
  return {
    view,
    discover,
    request,
    retireGeneration: () => {
      current = false;
    },
  };
}
it("blocks start before discovery even with an empty frontend", async () => {
  const { view, request } = setup();
  await view.request("browser");
  expect(request).not.toHaveBeenCalled();
});
it("checks every discovery scope field and never guesses missing native login identity", () => {
  for (const field of Object.keys(scope)) {
    const value = discovery();
    value.discovery.scope = {
      ...scope,
      [field]: field === "generation" ? 2 : "foreign",
    };
    expect(() => checkedCodexConfigureDiscovery(value, scope)).toThrow();
  }
  expect(() =>
    checkedCodexConfigureDiscovery(
      discovery({ ...operation, phase: "confirmed", loginId: null }),
      scope,
    ),
  ).toThrow();
});
it("in-flight reentry waits for an explicit fresh discovery before original status", async () => {
  const { view, discover, request } = setup();
  discover
    .mockResolvedValueOnce(discovery({ ...operation, inFlight: true }))
    .mockResolvedValueOnce(discovery());
  await view.discover();
  expect(view.getSnapshot().checked).toBe(false);
  await view.request("status");
  expect(request).not.toHaveBeenCalled();
  await view.discover();
  expect(request).toHaveBeenCalledExactlyOnceWith(scope, {
    action: "status",
    operationId: 7,
    loginId: "login-7",
  });
  expect(view.getSnapshot().checked).toBe(true);
});
it("does not accept a fresh completed browser receipt without its first native login identity", async () => {
  const { view, discover, request } = setup();
  discover.mockResolvedValue(
    discovery({
      ...operation,
      kind: "browser",
      phase: "starting",
      loginId: null,
    }),
  );
  const result = fresh("confirmed");
  request.mockResolvedValue({
    ...result,
    snapshot: { ...result.snapshot, loginId: null },
  });
  await view.discover();
  expect(view.getSnapshot().checked).toBe(false);
  expect(view.getSnapshot().error).toContain("未知");
});
it.each(["waiting", "confirmed"])(
  "reattaches background %s by original device identity, never restarting",
  async (phase) => {
    const { view, discover, request } = setup();
    discover.mockResolvedValue(discovery());
    request.mockResolvedValue(fresh(phase));
    await view.discover();
    expect(request).toHaveBeenCalledExactlyOnceWith(scope, {
      action: "status",
      operationId: 7,
      loginId: "login-7",
    });
    expect(view.getSnapshot().snapshot?.phase).toBe(phase);
    view.retire();
    view.activate();
    expect(view.getSnapshot().snapshot).toBeNull();
    await view.discover();
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.getSnapshot().snapshot?.phase).toBe(phase);
  },
);
it("discards cross-generation discovery and late same-generation status after leave", async () => {
  const a = setup();
  let release!: (v: unknown) => void;
  a.discover.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = a.view.discover();
  a.retireGeneration();
  release(discovery());
  await pending;
  expect(a.request).not.toHaveBeenCalled();
  const b = setup();
  b.discover.mockResolvedValue(discovery());
  b.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const reading = b.view.discover();
  await Promise.resolve();
  b.view.retire();
  b.view.activate();
  release(fresh());
  await reading;
  expect(b.view.getSnapshot().snapshot).toBeNull();
  await b.view.request("browser");
  expect(b.request).toHaveBeenCalledTimes(1);
});
it("discovery-none is not atomic admission: occupied start stays unknown without retry", async () => {
  const { view, request } = setup();
  await view.discover();
  request.mockRejectedValue(new Error("occupied"));
  await view.request("browser");
  await view.request("browser");
  expect(request).toHaveBeenCalledTimes(1);
  expect(view.getSnapshot().error).toContain("未知");
});
it.each([
  { ...operation, kind: "future" },
  { ...operation, operationId: 0 },
  { ...operation, loginId: undefined },
  { ...operation, inFlight: true },
  { ...operation, phase: "unknown" },
])(
  "blocks malformed, in-flight or Unknown discovery without guessing or automatic retry",
  async (op) => {
    const { view, discover, request } = setup();
    discover.mockResolvedValue(discovery(op));
    await view.discover();
    await view.request("browser");
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(view.getSnapshot())).not.toContain("FRESH-CODE");
  },
);
