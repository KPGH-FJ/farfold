import { describe, it, expect } from "vitest";
import {
  CODEX_ACP_NATIVE_LOGIN_TYPES,
  acceptsCodexLoginCompletion,
  codexAcpLoginAvailability,
  codexAcpConfigureLabel,
  type CodexAcpConfigureSnapshot,
  type CodexAcpScope,
  type CodexAcpLoginView,
  type CodexNativeAccountOperation,
} from "./codex-acp-contract";

const scope: CodexAcpScope = {
  runtimeProductId: "codex",
  installationId: "installation",
  runtimeBuildId: "build",
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "adapter-build",
  connectionId: "connection",
  profileId: "profile",
  generation: 1,
};
describe("Codex ACP first-slice authentication contract", () => {
  it("does not turn credential commit or past confirmation into current readiness", () => {
    const snapshot: CodexAcpConfigureSnapshot = {
      scope,
      operationId: 1,
      phase: "confirmed",
      loginId: null,
      credentialState: "committed",
      accountState: "api_key",
      payload: null,
    };
    expect(codexAcpConfigureLabel(snapshot)).toContain("尚未验证");
    expect(
      codexAcpConfigureLabel({ ...snapshot, accountState: "unauthenticated" }),
    ).toBe("需要登录");
    expect(
      codexAcpConfigureLabel({ ...snapshot, accountState: "unconfirmed" }),
    ).toBe("账号状态待确认");
    expect(
      codexAcpConfigureLabel({ ...snapshot, phase: "canceled" }),
    ).toContain("仍需核对");
  });
  it("records fixed browser/device/key contracts without enabling real login", () => {
    expect(CODEX_ACP_NATIVE_LOGIN_TYPES).toEqual([
      "apiKey",
      "chatgpt",
      "chatgptDeviceCode",
    ]);
    const operations: CodexNativeAccountOperation[] = [
      { method: "account/login/start", params: { type: "chatgpt" } },
      { method: "account/login/start", params: { type: "chatgptDeviceCode" } },
      {
        method: "account/login/start",
        params: { type: "apiKey", apiKey: "synthetic-only" },
      },
      {
        method: "account/login/cancel",
        params: { loginId: "synthetic-login" },
      },
      { method: "account/logout", params: {} },
    ];
    expect(operations).toHaveLength(5);
    expect(codexAcpLoginAvailability().phase).toBe("unavailable");
  });
  it("rejects early, canceled, stale and foreign login completions", () => {
    const waiting: CodexAcpLoginView = {
      phase: "waiting",
      scope,
      reply: {
        type: "chatgptDeviceCode",
        loginId: "login",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "SYNTHETIC",
      },
    };
    const completion = { scope, loginId: "login", success: true };
    expect(acceptsCodexLoginCompletion(waiting, completion)).toBe(true);
    expect(
      acceptsCodexLoginCompletion(codexAcpLoginAvailability(), completion),
    ).toBe(false);
    expect(
      acceptsCodexLoginCompletion(
        { phase: "canceled", scope, loginId: "login" },
        completion,
      ),
    ).toBe(false);
    for (const key of Object.keys(scope) as (keyof CodexAcpScope)[]) {
      const wrong = {
        ...scope,
        [key]: key === "generation" ? 2 : "different",
      } as CodexAcpScope;
      expect(
        acceptsCodexLoginCompletion(waiting, { ...completion, scope: wrong }),
      ).toBe(false);
    }
    expect(
      acceptsCodexLoginCompletion(waiting, { ...completion, loginId: "old" }),
    ).toBe(false);
    expect(waiting.phase).toBe("waiting"); // Matching completion is not account verification.
  });
});
