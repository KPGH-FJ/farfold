import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { sessionToolsPort } from "./session_tools";
import { target } from "./session_tools.test-support";
import { openedThreadState } from "./session_open_state";
import { capability } from "./session_tools.test-support";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => vi.mocked(invoke).mockReset());
it("exposes exactly read and local status with preknown operation ownership, not raw RPC", async () => {
  await sessionToolsPort.read(target);
  await sessionToolsPort.status(target);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["session_tools_read", target],
    ["session_tools_status", target],
  ]);
});
it("passes the optional capability through a real acknowledged open, never inferring legacy authority", () => {
  const input = { agentId: "fixture", cwd: "/owned" };
  const result = {
    nativeSessionId: "native",
    connectionId: "connection",
    cwd: "/owned",
    configOptions: [],
    resumed: false,
    warnings: [],
  };
  expect(
    openedThreadState(
      input,
      { ...result, sessionToolInventory: capability },
      null,
    ).sessionToolInventory,
  ).toEqual(capability);
  expect(
    openedThreadState(input, result, null).sessionToolInventory,
  ).toBeNull();
  expect(
    openedThreadState(input, { ...result, meta: { tools: true } }, null)
      .sessionToolInventory,
  ).toBeNull();
});

it("keeps opening diagnostics on the matching thread without another tool query", () => {
  const input = { agentId: "fixture", cwd: "/owned" };
  const result = {
    nativeSessionId: "native",
    connectionId: "connection",
    cwd: "/owned",
    configOptions: [],
    resumed: false,
    warnings: [],
  };
  const startup = {
    reportedCount: 3,
    loadedCount: 1,
    failedCount: 1,
    unknownCount: 1,
  };
  expect(
    openedThreadState(
      input,
      { ...result, sessionToolInventory: { ...capability, startup } },
      null,
    ).sessionToolInventory?.startup,
  ).toEqual(startup);
  expect(
    openedThreadState(
      input,
      {
        ...result,
        connectionId: "other",
        sessionToolInventory: capability,
        meta: { extensionResults: [{ name: "PRIVATE", success: true }] },
      },
      null,
    ).sessionToolInventory?.startup,
  ).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});
