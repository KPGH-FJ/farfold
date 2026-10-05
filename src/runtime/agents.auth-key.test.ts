import { beforeEach, expect, it, vi } from "vitest";
import type { Channel } from "@tauri-apps/api/core";
import type { Credential } from "./credentials";
import type { PtyChunk } from "./agents";
const h = vi.hoisted(() => ({ invoke: vi.fn(), dispatch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { authKeySave, authRun } from "./agents";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { dispatchEvent: h.dispatch });
});
it("stores a method key only through the explicit safe entry and returns metadata", async () => {
  const metadata = {
    id: "method-reference",
    revision: "current-revision",
  } as Credential;
  h.invoke.mockResolvedValue(metadata);
  expect(
    await authKeySave({
      agentId: "generic-agent",
      methodId: "method",
      cwd: "/original",
      expectedProvider: "provider",
      label: "My key",
      key: "LOCAL-KEY-INPUT-CANARY",
    }),
  ).toBe(metadata);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("auth_key_save", {
    agentId: "generic-agent",
    methodId: "method",
    cwd: "/original",
    source: null,
    expectedProvider: "provider",
    label: "My key",
    key: "LOCAL-KEY-INPUT-CANARY",
  });
  expect(h.dispatch).toHaveBeenCalledOnce();
});
it("sends only the saved reference and its captured revision to authentication", async () => {
  const channel = {} as Channel<PtyChunk>;
  await authRun("generic-agent", "method", {
    cwd: "/original",
    attemptId: "attempt",
    credentialId: "method-reference",
    credentialRevision: "current-revision",
    onOutput: channel,
  });
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("auth_run", {
    agentId: "generic-agent",
    methodId: "method",
    cwd: "/original",
    source: null,
    attemptId: "attempt",
    viaTerminal: null,
    credentialId: "method-reference",
    credentialRevision: "current-revision",
    onOutput: channel,
  });
  expect(JSON.stringify(h.invoke.mock.calls)).not.toContain('"key":');
});
