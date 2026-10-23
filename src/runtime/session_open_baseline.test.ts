import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

import { OpeningBaseline } from "./session_open_baseline";
import { openedThreadState } from "./session_open_state";
import { applySessionEvent } from "./session_event_projection";
import { freshThreadState } from "./session_projection";
import { ownsConfigurationPause } from "./configuration_pause";
import type { OpenResult } from "./session_open_types";
import type { ThreadState } from "./session_types";

afterEach(() => vi.restoreAllMocks());

const input = {
  agentId: "known-agent",
  cwd: "/requested",
  nativeSessionId: "known",
};
const header = {
  cwd: "/canonical",
  sessionId: "known",
  connectionId: "actual",
};
const result: OpenResult = {
  cwd: header.cwd,
  nativeSessionId: header.sessionId,
  connectionId: header.connectionId,
  resumed: true,
  configOptions: [],
  warnings: [],
  configOptionsModern: false,
  modes: {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "work", name: "Work" },
    ],
  },
};
const mode = (currentModeId: unknown) => ({
  update: { sessionUpdate: "current_mode_update", currentModeId },
});
const options = (id: string, modern = false) => ({
  kind: "configOptions",
  modern,
  options: [{ id, name: id, type: "boolean", currentValue: false }],
});
const check = (status: "ready" | "blocked") => ({
  kind: "configCheck",
  check: { status, issues: [], current: { choices: [] } },
});
const permission = (permissionState: string, permissionConfigId?: string) => ({
  kind: "permissionState",
  permissionState,
  permissionConfigId,
  permissionEffect: {
    configId: permissionConfigId ?? "access",
    appliesAt: "next_ordinary_prompt",
    currentScope: "unknown",
  },
});
const title = (value: string) => ({
  update: { sessionUpdate: "session_info_update", title: value },
});
const metadata = (state: ThreadState) => ({
  key: state.key,
  agentId: state.agentId,
  cwd: state.cwd,
  nativeSessionId: state.nativeSessionId,
  connectionId: state.connectionId,
  service: state.service,
  identity: state.identity,
  title: state.title,
  metaDirty: state.metaDirty,
  configOptions: state.configOptions,
  currentModeId: state.currentModeId,
  modesSeparate: state.modesSeparate,
  permissionConfigId: state.permissionConfigId,
  permissionState: state.permissionState,
  permissionEffect: state.permissionEffect,
  configCheck: state.configCheck,
  configError: state.configError,
  modelDrift: state.modelDrift,
  queuePaused: state.queuePaused,
  configOwnsPause: ownsConfigurationPause(state),
  uncertainPrompt: state.uncertainPrompt,
  stopUnconfirmed: state.stopUnconfirmed,
  connectionOutcomeUnknown: state.connectionOutcomeUnknown,
});
function staged(
  events: unknown[],
  baseline = result,
  savedTitle: string | null = null,
  existing?: ThreadState,
) {
  const opening = new OpeningBaseline(input, existing);
  opening.identify(header);
  for (const event of events) {
    opening.observe(event);
    applySessionEvent(opening.state, event, false);
  }
  return opening.accept(baseline, savedTitle);
}
function original(
  events: unknown[],
  baseline = result,
  savedTitle: string | null = null,
  existing?: ThreadState,
) {
  const state = openedThreadState(input, baseline, savedTitle, existing);
  for (const event of events) applySessionEvent(state, event, false);
  return state;
}

it.each([
  [mode("work")],
  [mode("work"), options("model-a")],
  [options("model-a"), mode("work"), options("model-b")],
  [
    mode("work"),
    options("modern", true),
    mode("ignored"),
    options("later-legacy"),
  ],
  [options("mode"), mode("ignored")],
  [check("blocked"), check("ready")],
  [permission("unknown", "access"), check("blocked"), check("ready")],
  [check("blocked"), permission("required", "access"), check("ready")],
  [
    permission("unknown", "access"),
    permission("ready"),
    permission("ready", "other"),
  ],
  [
    check("blocked"),
    { kind: "serviceUnavailable", message: "local unavailable" },
    check("ready"),
  ],
])(
  "matches baseline-first metadata for ordered effects %j",
  (...events: unknown[]) => {
    const actual = staged(events);
    const expected = original(events);
    expect(metadata(actual)).toEqual(metadata(expected));
  },
);

it.each([null, "saved title"])(
  "keeps title priority with saved title %s and only first Agent title",
  (savedTitle) => {
    const events = [title("first reported"), title("second reported")];
    expect(metadata(staged(events, result, savedTitle))).toEqual(
      metadata(original(events, result, savedTitle)),
    );
    const existing = freshThreadState(
      "old",
      input.agentId,
      "/canonical",
      "known",
    );
    existing.title = "user title";
    expect(metadata(staged(events, result, savedTitle, existing))).toEqual(
      metadata(original(events, result, savedTitle, existing)),
    );
  },
);

it("requires an actual matching opening header before events or acceptance", () => {
  const opening = new OpeningBaseline(input);
  expect(opening.state.nativeSessionId).toBe("");
  expect(() => opening.observe(title("unknown owner"))).toThrow();
  expect(() => opening.accept(result, null)).toThrow();
  opening.identify(header);
  opening.identify(header);
  expect(() =>
    opening.identify({ ...header, sessionId: "different" }),
  ).toThrow();
  expect(() =>
    opening.accept({ ...result, nativeSessionId: "different" }, null),
  ).toThrow();
  expect(() =>
    opening.accept({ ...result, connectionId: "other" }, null),
  ).toThrow();
  expect(opening.state.items).toEqual([]);
});

it("preserves an early unsupported opening notice in the same private view without changing existing work", () => {
  const existing = freshThreadState(
    "existing",
    input.agentId,
    header.cwd,
    header.sessionId,
  );
  existing.queued = [[{ type: "text", text: "original paused input" }]];
  existing.queuePaused = "stopped";
  const originalItems = existing.items;
  const originalQueue = existing.queued;
  const opening = new OpeningBaseline(input, existing);
  const params = { mode: "future", unknown: [null, "中文🙂"] };
  const event = { kind: "elicitationUnavailable", params };
  opening.observe(event);
  applySessionEvent(opening.state, event, false);
  expect(opening.state.nativeSessionId).toBe("");
  const privateItems = opening.state.items;
  opening.identify(header);
  expect(opening.state.queuePaused).toBe("unavailable");
  opening.observe(check("ready"));
  applySessionEvent(opening.state, check("ready"), false);
  expect(existing.items).toBe(originalItems);
  expect(existing.queued).toBe(originalQueue);
  expect(existing.queuePaused).toBe("stopped");
  const accepted = opening.accept(result, null, existing);
  expect(accepted.items).toBe(privateItems);
  expect(accepted.items).toContainEqual(
    expect.objectContaining({ kind: "raw", update: params }),
  );
  expect(accepted.queuePaused).toBe("unavailable");
  expect(ownsConfigurationPause(accepted)).toBe(false);
  expect(accepted.queued).toBe(originalQueue);
});

it("does not let an early notice guess identity or admit an update-shaped homonym", () => {
  const opening = new OpeningBaseline(input);
  const event = { kind: "elicitationUnavailable", params: { exact: true } };
  opening.observe(event);
  applySessionEvent(opening.state, event, false);
  expect(() => opening.accept(result, null)).toThrow();
  expect(() => opening.observe({ ...event, update: null })).toThrow();
  expect(opening.state.key).toBe("");
  expect(opening.state.connectionId).toBeUndefined();
});

it("restores queued work only under the actual key and copies its mutable container", () => {
  const queued = [[{ type: "text" as const, text: "unsent" }]];
  const restore = vi.fn((state: ThreadState) => {
    expect(state.key).toBe("known-agent:/canonical:known");
    state.queued = queued;
    state.queuePaused = "stopped";
  });
  const opening = new OpeningBaseline(input, undefined, restore);
  expect(restore).not.toHaveBeenCalled();
  opening.identify(header);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(opening.state.queued).not.toBe(queued);
  expect(opening.state.queued[0]).toBe(queued[0]);
  const items = opening.state.items;
  const accepted = opening.accept(result, null);
  expect(accepted).toBe(opening.state);
  expect(accepted.items).toBe(items);
  expect(accepted.queued).toBe(queued);
  expect(() => opening.accept(result, null)).toThrow();
});

it("does not remove old uncertain work until successful acceptance, while preserving later user additions", () => {
  const existing = freshThreadState(
    "known-agent:/canonical:known",
    input.agentId,
    "/canonical",
    "known",
  );
  const uncertain = [{ type: "text" as const, text: "uncertain request" }];
  const later = [{ type: "text" as const, text: "later user addition" }];
  existing.queued = [uncertain];
  existing.uncertainPrompt = uncertain;
  existing.queuePaused = "uncertain";
  const originalQueue = existing.queued;
  const opening = new OpeningBaseline(input, existing);
  opening.identify(header);
  const end = { kind: "turnEnd", stopReason: "cancelled" };
  opening.observe(end);
  applySessionEvent(opening.state, end, false);
  expect(opening.state.queued).toEqual([]);
  expect(existing.queued).toEqual([uncertain]);
  expect(existing.uncertainPrompt).toBe(uncertain);
  existing.queued.push(later);
  const accepted = opening.accept(
    { ...result, permissionConfigId: "access" },
    null,
    existing,
  );
  expect(accepted.queued).toBe(originalQueue);
  expect(accepted.queued).toEqual([later]);
  expect(accepted.uncertainPrompt).toBeNull();
  expect(accepted.queuePaused).toBe("stopped");
});

it("keeps original drafts untouched when baseline conversion fails after a private turn end", () => {
  const existing = freshThreadState(
    "known-agent:/canonical:known",
    input.agentId,
    "/canonical",
    "known",
  );
  existing.queued = [[{ type: "text", text: "keep on failure" }]];
  existing.uncertainPrompt = existing.queued[0];
  const opening = new OpeningBaseline(input, existing);
  opening.identify(header);
  const event = { kind: "turnEnd", stopReason: "cancelled" };
  opening.observe(event);
  applySessionEvent(opening.state, event, false);
  expect(() =>
    opening.accept(
      {
        ...result,
        configOptions: [{ id: JSON.parse('{"toString":null,"valueOf":null}') }],
      },
      null,
    ),
  ).toThrow(TypeError);
  expect(existing.queued).toHaveLength(1);
  expect(existing.uncertainPrompt).toBe(existing.queued[0]);
});

it("validates every relevant conditional legacy conversion even if a later full replacement removes mode", () => {
  const bad = mode(JSON.parse('{"toString":null,"valueOf":null}'));
  expect(() => staged([bad, options("modern", true)])).toThrow(TypeError);
  expect(() =>
    staged([bad], { ...result, configOptionsModern: true }),
  ).not.toThrow();
  expect(() => staged([options("modern", true), bad])).not.toThrow();
});

it("retains the old history-only config conversion guard without applying raw configuration to the view", () => {
  const event = {
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [{ id: JSON.parse('{"toString":null,"valueOf":null}') }],
    },
  };
  const opening = new OpeningBaseline(input);
  opening.identify(header);
  expect(() => opening.observe(event, "history")).toThrow(TypeError);
  expect(() => opening.observe(event, "following")).not.toThrow();
  applySessionEvent(opening.state, event, true);
  const accepted = opening.accept(result, null);
  expect(
    accepted.items.some(
      (item) => item.kind === "raw" && item.update === event.update,
    ),
  ).toBe(true);
  expect(accepted.configOptions.map((option) => option.id)).toEqual(["mode"]);
});

it("keeps result metadata TypeError protection even when a later configuration supersedes it", () => {
  expect(() =>
    staged([options("valid", true)], {
      ...result,
      configOptions: [{ id: JSON.parse('{"toString":null,"valueOf":null}') }],
    }),
  ).toThrow(TypeError);
});

it("does not store body events or reproject their items at acceptance", () => {
  const opening = new OpeningBaseline(input);
  opening.identify(header);
  const project = vi.fn((event: unknown) =>
    applySessionEvent(opening.state, event, false),
  );
  for (let i = 0; i < 1024; i++) {
    const event = {
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: String(i),
        content: { type: "text", text: `body-${i}` },
      },
    };
    opening.observe(event);
    project(event);
  }
  const items = opening.state.items;
  const accepted = opening.accept(result, null);
  expect(accepted.items).toBe(items);
  expect(items).toHaveLength(1024);
  expect(project).toHaveBeenCalledTimes(1024);
  expect(items.at(-1)).toMatchObject({ text: "body-1023" });
});

it.each([
  { permissionConfigId: "access" },
  {
    resumed: false,
    permissionConfigId: "access",
    permissionState: "ready" as const,
  },
  {
    configCheck: {
      status: "blocked" as const,
      issues: [],
      current: { choices: [] },
    },
  },
  {
    configCheck: {
      status: "ready" as const,
      issues: [],
      current: { choices: [] },
    },
    warnings: ["retained warning"],
  },
])(
  "preserves conditional queue/config ownership for actual result baseline %j",
  (overrides) => {
    const baseline = { ...result, ...overrides };
    for (const events of [
      [check("ready")],
      [check("blocked"), check("ready")],
      [permission("required", "access"), check("blocked")],
      [check("blocked"), permission("ready", "access"), check("ready")],
      [check("blocked"), permission("unknown", "other"), check("ready")],
      [
        permission("unknown", "access"),
        { kind: "elicitationUnavailable", params: null },
        check("ready"),
      ],
    ]) {
      expect(metadata(staged(events, baseline))).toEqual(
        metadata(original(events, baseline)),
      );
      const makeExisting = () => {
        const state = freshThreadState(
          "old",
          input.agentId,
          "/canonical",
          "known",
        );
        state.queued = [[{ type: "text" as const, text: "pending" }]];
        state.uncertainPrompt = state.queued[0];
        state.queuePaused = "uncertain";
        state.stopUnconfirmed = true;
        return state;
      };
      expect(metadata(staged(events, baseline, null, makeExisting()))).toEqual(
        metadata(original(events, baseline, null, makeExisting())),
      );
    }
  },
);
