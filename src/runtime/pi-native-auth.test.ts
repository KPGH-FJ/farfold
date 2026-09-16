import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import {
  piNativeAuthLabel,
  piNativeAuthPending,
  requestPiNativeAuth,
  readPiNativeAuthCatalog,
  type PiNativeAuthSnapshot,
} from "./pi-native-auth";
const target = {
  farfoldSessionId: "host",
  nativeSessionId: "native",
  runtimeGeneration: 9,
};
beforeEach(() => vi.mocked(invoke).mockReset());
it("native login and secrets use only the exact transient ACP target, never managed or Agent commands", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  await requestPiNativeAuth(target, {
    action: "reply",
    flowId: "flow",
    promptId: "prompt",
    value: "synthetic-secret",
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("pi_acp_native_auth", {
    input: {
      ...target,
      command: {
        action: "reply",
        flowId: "flow",
        promptId: "prompt",
        value: "synthetic-secret",
      },
    },
  });
});
it("catalog reads remain on the original ACP workspace", async () => {
  vi.mocked(invoke).mockResolvedValue({ providers: [] });
  expect(await readPiNativeAuthCatalog(target)).toEqual({ providers: [] });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("pi_acp_workspace", {
    input: { ...target, section: "auth_catalog" },
  });
});
it("committed credentials never imply a model request or confirmed refresh", () => {
  const flow: PiNativeAuthSnapshot = {
    version: 1,
    sessionId: "native",
    flowId: "flow",
    providerId: "anthropic",
    authType: "oauth",
    operation: "login",
    state: "unknown",
    credentialState: "committed",
    refreshState: "unknown",
    prompt: null,
    notice: null,
  };
  expect(piNativeAuthLabel(flow)).toContain("凭据已保存，刷新未确认");
  expect(piNativeAuthPending(flow)).toBe(false);
  expect(
    piNativeAuthLabel({
      ...flow,
      state: "succeeded",
      refreshState: "confirmed",
    }),
  ).toContain("尚未验证模型请求");
  expect(piNativeAuthLabel({ ...flow, credentialState: "unknown" })).toContain(
    "是否改变尚未确认",
  );
  expect(piNativeAuthPending({ ...flow, state: "cancelling" })).toBe(true);
});
