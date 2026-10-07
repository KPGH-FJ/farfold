import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));

import { threads } from "./sessions";
import {
  applyUpdate,
  freshThreadState,
  normalizeConfigOptions,
} from "./session_projection";
import { archiveActivity } from "./archive_activity";
import { draftPersistence } from "./drafts";

const modes = {
  currentModeId: "medium",
  availableModes: ["medium", "off"].map((id) => ({
    id,
    name: `Thinking: ${id}`,
  })),
};
const options = (value = "medium") => [
  {
    id: "thought_level",
    category: "thought_level",
    type: "select",
    name: "Thinking",
    currentValue: value,
    options: modes.availableModes.map(({ id, name }) => ({ value: id, name })),
  },
];
const check = (value = "medium") => ({
  status: "ready",
  issues: [],
  protectedIds: ["thought_level"],
  current: {
    choices: [
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        value,
      },
    ],
  },
});

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue([]);
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

it("does not let an old mode notification overwrite a modern mode choice", () => {
  const state = freshThreadState(
    "modern-mode",
    "config-surfaces",
    "/config-surfaces",
    "modern-mode",
  );
  state.configOptions = normalizeConfigOptions([
    {
      id: "actual-mode",
      category: "mode",
      type: "select",
      name: "Mode",
      currentValue: "ask",
      options: [
        { value: "ask", name: "Ask" },
        { value: "code", name: "Code" },
      ],
    },
  ]);
  applyUpdate(state, {
    sessionUpdate: "current_mode_update",
    currentModeId: "code",
  });
  expect(state.configOptions[0].currentValue).toBe("ask");
  expect(state.currentModeId).toBeNull();
});

it("uses only modern thinking choices when a restored conversation also advertises legacy modes", async () => {
  let channel: { onmessage: (event: unknown) => void };
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      channel = args.channel;
      channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "earlier reply" },
        },
      });
      channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return {
        cwd: "/config-surfaces",
        nativeSessionId: "modern-dual",
        resumed: true,
        configOptions: options(),
        modes,
        configCheck: check(),
      };
    }
    if (command === "session_set_config") {
      expect(args.configId).toBe("thought_level");
      channel.onmessage({
        kind: "configCheck",
        check: {
          ...check(args.value),
          status: "blocked",
          issues: [
            {
              id: "thought_level",
              category: "thought_level",
              reason: "changed",
              expected: "medium",
              current: args.value,
            },
          ],
        },
      });
      channel.onmessage({
        kind: "configOptions",
        options: options(args.value),
      });
      channel.onmessage({ kind: "configCheck", check: check(args.value) });
      return {
        configOptions: options(args.value),
        configCheck: check(args.value),
        permissionConfigId: null,
        permissionState: "ready",
        service: null,
      };
    }
    if (command === "session_prompt") return { status: "accepted" };
    return [];
  });
  const state = await threads.open({
    agentId: "config-surfaces-modern",
    cwd: "/config-surfaces",
    nativeSessionId: "modern-dual",
  });
  expect(state.configOptions.map((option) => option.id)).toEqual([
    "thought_level",
  ]);
  expect(state.modesSeparate).toBe(false);
  await expect(threads.setConfig(state.key, "mode", "off")).rejects.toThrow();
  await threads.setConfig(state.key, "thought_level", "off");
  expect(state.configOptions[0].currentValue).toBe("off");
  expect(state.configCheck?.status).toBe("ready");
  expect(state.modelDrift).toBe(false);
  expect(
    state.items.some(
      (item) => item.kind === "agent" && item.text === "earlier reply",
    ),
  ).toBe(true);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_set_mode"),
  ).toBe(false);
  await expect(
    threads.send(state.key, [{ type: "text", text: "new request" }]),
  ).resolves.toEqual({ status: "accepted" });
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(1);
});

it("keeps legacy modes when the unified list contains only a synthesized legacy model", async () => {
  const legacyOptions = [
    {
      id: "__farfold_legacy_model",
      category: "model",
      type: "select",
      name: "Model",
      currentValue: "first",
      options: [
        { value: "first", name: "First" },
        { value: "second", name: "Second" },
      ],
    },
  ];
  const modelCheck = (value: string) => ({
    status: "ready",
    issues: [],
    protectedIds: ["__farfold_legacy_model"],
    current: {
      choices: [
        {
          id: "__farfold_legacy_model",
          category: "model",
          type: "select",
          value,
        },
      ],
    },
  });
  h.invoke.mockImplementation(async (command) =>
    command === "session_open"
      ? {
          cwd: "/config-surfaces",
          nativeSessionId: "legacy-model-and-mode",
          resumed: false,
          configOptionsModern: false,
          modes,
          configOptions: legacyOptions,
          configCheck: modelCheck("first"),
        }
      : command === "session_set_config"
        ? {
            configOptionsModern: false,
            configOptions: legacyOptions.map((option) => ({
              ...option,
              currentValue: "second",
            })),
            configCheck: modelCheck("second"),
            permissionConfigId: null,
            permissionState: "ready",
            service: null,
          }
        : [],
  );
  const state = await threads.open({
    agentId: "config-surfaces-legacy-model",
    cwd: "/config-surfaces",
    fresh: true,
  });
  expect(state.modesSeparate).toBe(true);
  await threads.setConfig(state.key, "__farfold_legacy_model", "second");
  expect(state.modesSeparate).toBe(true);
  expect(state.configOptions.map((option) => option.id)).toEqual([
    "__farfold_legacy_model",
    "mode",
  ]);
  const channel = h.invoke.mock.calls.find(
    ([command]) => command === "session_open",
  )?.[1].channel;
  channel.onmessage({
    kind: "configOptions",
    modern: false,
    options: state.configOptions.filter(
      (option: { id: string }) => option.id !== "mode",
    ),
  });
  expect(state.modesSeparate).toBe(true);
  expect(state.configOptions.map((option) => option.id)).toEqual([
    "__farfold_legacy_model",
    "mode",
  ]);
});

it.each([{ configOptions: [] }, { configOptions: options() }])(
  "does not expose legacy modes for a declared modern list %j",
  async ({ configOptions }) => {
    h.invoke.mockImplementation(async (command) =>
      command === "session_open"
        ? {
            cwd: "/config-surfaces",
            nativeSessionId: `modern-list-${configOptions.length}`,
            resumed: false,
            configOptions,
            modes,
          }
        : [],
    );
    const state = await threads.open({
      agentId: `config-surfaces-list-${configOptions.length}`,
      cwd: "/config-surfaces",
      fresh: true,
    });
    expect(state.configOptions.map((option) => option.id)).toEqual(
      configOptions.map((option) => option.id),
    );
    expect(state.modesSeparate).toBe(false);
  },
);

it("preserves a legacy-only choice until a complete modern declaration replaces it", async () => {
  let channel: { onmessage: (event: unknown) => void };
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      channel = args.channel;
      return {
        cwd: "/config-surfaces",
        nativeSessionId: "legacy-only",
        resumed: false,
        configOptions: null,
        modes,
      };
    }
    if (command === "session_set_mode") return undefined;
    return [];
  });
  const state = await threads.open({
    agentId: "config-surfaces-legacy",
    cwd: "/config-surfaces",
    fresh: true,
  });
  expect(state.modesSeparate).toBe(true);
  await threads.setConfig(state.key, "mode", "off");
  expect(state.currentModeId).toBe("off");
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_set_mode"),
  ).toHaveLength(1);
  channel!.onmessage({ kind: "configOptions", options: options("off") });
  expect(state.configOptions.map((option) => option.id)).toEqual([
    "thought_level",
  ]);
  expect(state.modesSeparate).toBe(false);
  h.invoke.mockClear();
  await expect(
    threads.setConfig(state.key, "mode", "medium"),
  ).rejects.toThrow();
  expect(h.invoke).not.toHaveBeenCalled();
});
