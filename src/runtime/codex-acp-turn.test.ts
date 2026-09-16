import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  requestCodexAcpTurn,
  type CodexAcpTurnCommand,
} from "./codex-acp-turn";
import type { CodexAcpScope } from "./codex-acp-contract";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const ipc = vi.mocked(invoke);
const scope: CodexAcpScope = {
  runtimeProductId: "codex",
  installationId: "install",
  runtimeBuildId: "build",
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "adapter",
  connectionId: "connection",
  profileId: "profile",
  generation: 1,
};
const send: CodexAcpTurnCommand = {
  action: "send",
  farfoldSessionId: "session",
  text: "Synthetic",
};
const snapshot = {
  scope,
  farfoldSessionId: "session",
  hostTurnId: "host-turn",
  nativeTurnId: "019a0000-0000-7000-8000-000000000001",
  outcome: "started",
};
const interrupt: CodexAcpTurnCommand = {
  action: "interrupt",
  farfoldSessionId: "session",
  hostTurnId: snapshot.hostTurnId,
  nativeTurnId: snapshot.nativeTurnId,
};
beforeEach(() => {
  ipc.mockReset();
});
it("sends once through the closed facade with Host ID and text only", async () => {
  ipc.mockResolvedValue({ kind: "turn", snapshot });
  await expect(requestCodexAcpTurn(scope, send)).resolves.toEqual(snapshot);
  expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_operation", {
    input: { action: "turn", scope, command: send },
  });
});
it("Stop accepts only original Host/native Turn receipt, never terminal", async () => {
  const ack = { ...snapshot, outcome: "interrupt_accepted" };
  ipc.mockResolvedValue({ kind: "turn", snapshot: ack });
  await expect(requestCodexAcpTurn(scope, interrupt)).resolves.toEqual(ack);
  for (const change of [
    { hostTurnId: "other" },
    { nativeTurnId: "019a0000-0000-7000-8000-000000000002" },
    { outcome: "completed" },
  ]) {
    ipc.mockResolvedValueOnce({
      kind: "turn",
      snapshot: { ...ack, ...change },
    });
    await expect(requestCodexAcpTurn(scope, interrupt)).rejects.toThrow(
      "Stop 接受不代表",
    );
  }
  expect(ipc).toHaveBeenCalledTimes(4);
});
it("rejects empty, UTF8 oversized and free native fields before IPC", async () => {
  for (const command of [
    { ...send, text: " " },
    { ...send, text: "中".repeat(22000) },
    { ...send, cwd: "/wrong" },
    { ...send, nativeThreadId: "foreign" },
    { ...interrupt, hostTurnId: "" },
  ]) {
    await expect(
      requestCodexAcpTurn(scope, command as CodexAcpTurnCommand),
    ).rejects.toThrow();
  }
  expect(ipc).not.toHaveBeenCalled();
});
it("rejects every scope drift and malformed/private reply without retry", async () => {
  for (const key of Object.keys(scope)) {
    ipc.mockResolvedValueOnce({
      kind: "turn",
      snapshot: {
        ...snapshot,
        scope: { ...scope, [key]: key === "generation" ? 2 : "foreign" },
      },
    });
    await expect(requestCodexAcpTurn(scope, send)).rejects.toThrow(
      "不会自动重试",
    );
  }
  for (const raw of [
    null,
    { kind: "turn", snapshot: { ...snapshot, private: "SECRET" } },
    { kind: "turn", snapshot: { ...snapshot, scope: null } },
    { kind: "turn", snapshot: { ...snapshot, farfoldSessionId: "foreign" } },
  ]) {
    ipc.mockResolvedValueOnce(raw);
    await expect(requestCodexAcpTurn(scope, send)).rejects.toThrow(
      "不会自动重试",
    );
  }
  expect(ipc).toHaveBeenCalledTimes(12);
});
it("does not echo native error or retry unknown send", async () => {
  ipc.mockRejectedValue(new Error("SECRET"));
  await expect(requestCodexAcpTurn(scope, send)).rejects.toThrow("回执未确认");
  expect(ipc).toHaveBeenCalledTimes(1);
});
it("captures original request before awaiting so caller mutation cannot retarget receipt", async () => {
  const mutableScope = { ...scope };
  const command = { ...interrupt };
  let release!: (r: unknown) => void;
  ipc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = requestCodexAcpTurn(mutableScope, command);
  mutableScope.generation = 2;
  command.hostTurnId = "other";
  release({
    kind: "turn",
    snapshot: { ...snapshot, outcome: "interrupt_accepted" },
  });
  await expect(pending).resolves.toMatchObject({
    scope,
    hostTurnId: "host-turn",
  });
});
