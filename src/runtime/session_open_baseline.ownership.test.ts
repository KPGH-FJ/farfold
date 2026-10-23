import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

import { OpeningBaseline } from "./session_open_baseline";
import { SessionOpenReplay } from "./session_open_replay";
import { applySessionEvent } from "./session_event_projection";
import { applyConfigCheck } from "./config_check";
import {
  configurationPauseRevision,
  ownsConfigurationPause,
} from "./configuration_pause";
import { ConfigurationRecheck } from "./session_config_recheck";
import { freshThreadState } from "./session_projection";
import type { OpenResult } from "./session_open_types";

const input = {
  agentId: "baseline-owner",
  cwd: "/owned",
  nativeSessionId: "history",
};
const header = {
  cwd: "/owned",
  sessionId: "history",
  connectionId: "new-connection",
};
const result: OpenResult = {
  cwd: header.cwd,
  nativeSessionId: header.sessionId,
  connectionId: header.connectionId,
  resumed: true,
  service: null,
  configOptions: [],
  warnings: [],
  configCheck: { status: "ready", current: { choices: [] }, issues: [] },
};
const body = {
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "retained" },
  },
};
function existing() {
  const state = freshThreadState(
    `${input.agentId}:${input.cwd}:${input.nativeSessionId}`,
    input.agentId,
    input.cwd,
    input.nativeSessionId,
  );
  state.identity = "established";
  applyConfigCheck(state, { status: "blocked", current: {}, issues: [] });
  return state;
}

it("baseline reconciliation adds no pause writer and explicit ready recheck releases only its transferred pause", () => {
  const old = existing();
  const recheck = new ConfigurationRecheck(
    old,
    () => old,
    () => 0,
  );
  const opening = new OpeningBaseline(input, old);
  opening.identify(header);
  opening.observe(body);
  applySessionEvent(opening.state, body, false);
  const state = opening.accept(result, null);
  expect(configurationPauseRevision(state)).toBe(0);
  expect(state.queuePaused).toBe("unavailable");
  recheck.finish(state, result);
  expect(state.queuePaused).toBeNull();
});

it.each([false, true])(
  "real unavailable pause is never erased by baseline reconciliation (early=%s)",
  (early) => {
    const old = existing();
    const recheck = new ConfigurationRecheck(
      old,
      () => old,
      () => 0,
    );
    const opening = new OpeningBaseline(input, old);
    const notice = {
      kind: "elicitationUnavailable",
      params: { retained: true },
    };
    if (!early) opening.identify(header);
    opening.observe(notice);
    applySessionEvent(opening.state, notice, false);
    if (early) opening.identify(header);
    const state = opening.accept(result, null);
    expect(configurationPauseRevision(state)).toBeGreaterThan(0);
    expect(ownsConfigurationPause(state)).toBe(false);
    recheck.finish(state, result);
    expect(state.queuePaused).toBe("unavailable");
  },
);

function replay() {
  const value = new SessionOpenReplay(
    input,
    undefined,
    undefined,
    "00000000-0000-4000-8000-000000000001",
  );
  value.push({ kind: "sessionOpening", openToken: value.token, ...header });
  return value;
}

it("only accepted private permission controls contribute their actual finite change count", () => {
  const value = replay();
  value.push(body);
  value.push({ kind: "permissionState", permissionState: "unknown" });
  value.push({ kind: "permissionState", permissionState: "required" });
  value.push({ kind: "permissionState", permissionState: "ready" });
  value.push({
    kind: "permissionState",
    permissionState: "unknown",
    update: { sessionUpdate: "future" },
  });
  expect(value.acceptedPermissionChanges).toBe(0);
  value.receiveMarker({
    kind: "session_history_complete",
    openToken: value.token,
  });
  const state = value.accept(result, null);
  expect(value.acceptedPermissionChanges).toBe(2);
  expect(state.permissionState).toBe("required");
  expect(() => value.accept(result, null)).toThrow();
  expect(value.acceptedPermissionChanges).toBe(2);
});

it("failed empty history never publishes private permission changes", () => {
  const value = replay();
  value.push({ kind: "permissionState", permissionState: "unknown" });
  value.receiveMarker({
    kind: "session_history_complete",
    openToken: value.token,
  });
  expect(() => value.accept(result, null)).toThrow();
  expect(value.acceptedPermissionChanges).toBe(0);
  value.clear();
  expect(value.acceptedPermissionChanges).toBe(0);
});

it("foreign result identity cannot publish an otherwise readable permission prefix", () => {
  const value = replay();
  value.push(body);
  value.push({ kind: "permissionState", permissionState: "unknown" });
  value.receiveMarker({
    kind: "session_history_complete",
    openToken: value.token,
  });
  expect(() =>
    value.accept({ ...result, connectionId: "foreign" }, null),
  ).toThrow();
  expect(value.acceptedPermissionChanges).toBe(0);
});
