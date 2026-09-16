import { describe, expect, it } from "vitest";
import {
  codexAccountLabel,
  catalogMatchesConnection,
  type CodexConnectionStatus,
} from "./codex-connection";

const status: CodexConnectionStatus = {
  generation: 1,
  installationId: "installation",
  connectionId: "connection",
  processRunning: true,
  initialized: true,
  stateDirectory: "/private/codex",
  account: null,
  loginPhase: null,
  diagnosticCount: 0,
  diagnosticMethods: [],
  droppedEvents: 0,
  error: null,
};

describe("Codex account presentation", () => {
  it("rejects model catalogs from a previous connection or stopped process", () => {
    const catalog = {
      installationId: "installation",
      generation: 1,
      models: [],
    };
    expect(catalogMatchesConnection(catalog, status)).toBe(true);
    expect(
      catalogMatchesConnection(catalog, { ...status, generation: 2 }),
    ).toBe(false);
    expect(
      catalogMatchesConnection(catalog, {
        ...status,
        installationId: "another",
      }),
    ).toBe(false);
    expect(
      catalogMatchesConnection(catalog, { ...status, processRunning: false }),
    ).toBe(false);
    expect(
      catalogMatchesConnection(catalog, { ...status, initialized: false }),
    ).toBe(false);
    expect(catalogMatchesConnection(catalog, null)).toBe(false);
  });
  it("distinguishes an unconfirmed read, missing authentication and an optional-auth provider", () => {
    expect(codexAccountLabel(status)).toBe("账号状态尚未确认");
    expect(
      codexAccountLabel({
        ...status,
        account: { account: null, requiresOpenaiAuth: true },
      }),
    ).toBe("尚未登录");
    expect(
      codexAccountLabel({
        ...status,
        account: { account: null, requiresOpenaiAuth: false },
      }),
    ).toContain("不要求 OpenAI 认证");
  });
  it("does not keep claiming an account after the connection fails or equate a key with a successful request", () => {
    const configured = {
      ...status,
      account: {
        account: { type: "apiKey" as const },
        requiresOpenaiAuth: true,
      },
    };
    expect(codexAccountLabel(configured)).toContain("尚未验证请求");
    expect(codexAccountLabel({ ...configured, initialized: false })).toBe(
      "连接尚未就绪",
    );
  });
});
