import { expect, it, vi } from "vitest";
import { freshThreadState, normalizeConfigOptions } from "./session_projection";
import { openedThreadState } from "./session_open_state";
import {
  configurationRestoreIntent,
  mirroredConfigurationChoice,
  restoreSavedConfiguration,
} from "./saved_configuration_restore";

function state() {
  const value = freshThreadState("owned", "chosen", "/controlled", "native");
  value.service = {
    id: "selected",
    model: "chosen-model",
    fingerprint: "source",
  };
  value.serviceModelValue = "chosen-model";
  value.configOptions = normalizeConfigOptions([
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "chosen-model",
      options: [{ value: "chosen-model", name: "Chosen" }],
    },
    {
      id: "thought",
      category: "thought_level",
      name: "Thinking",
      type: "select",
      currentValue: "medium",
      options: [{ value: "medium", name: "Medium" }],
    },
    {
      id: "permission",
      category: "mode",
      name: "Permission",
      type: "select",
      currentValue: "ask",
      options: [{ value: "ask", name: "Ask" }],
    },
  ]);
  return value;
}
it("preserves only original protected intent plus the complete current nonprotected projection", () => {
  const value = state();
  value.configCheck = {
    status: "blocked",
    issues: [],
    protectedIds: ["removed-thought"],
    current: {},
  };
  expect(
    mirroredConfigurationChoice(value, {
      model: "original",
      "removed-thought": "high",
      stalePermission: "old",
    }),
  ).toEqual({
    model: "original",
    "removed-thought": "high",
    permission: "ask",
  });
  expect(mirroredConfigurationChoice(value, {})).toEqual({ permission: "ask" });
});
it("uses the explicit service model rather than a default notification and requires actual readback", () => {
  const value = state();
  expect(configurationRestoreIntent(value, {}, "chosen-model")).toEqual({
    model: "chosen-model",
  });
  expect(configurationRestoreIntent(value, {})).toEqual({});
  expect(() => configurationRestoreIntent(value, {}, "other-model")).toThrow();
  expect(() =>
    configurationRestoreIntent(value, { model: "other-model" }, "chosen-model"),
  ).toThrow();
  value.configOptions = value.configOptions.filter(
    (item) => item.id !== "model",
  );
  expect(configurationRestoreIntent(value, {}, "chosen-model")).toEqual({});
});
it("restores the exact model value confirmed for the selected API connection", () => {
  const logicalModel = "vendor/example:free";
  const service = {
    id: "selected",
    model: logicalModel,
    fingerprint: "source",
  };
  const wireModel = `farfold_${"a".repeat(64)}/${logicalModel}`;
  const alternative = `farfold_${"b".repeat(64)}/${logicalModel}`;
  const result = {
    cwd: "/controlled",
    nativeSessionId: "native",
    service,
    serviceModelValue: wireModel,
    resumed: false,
    warnings: [],
    configOptions: [
      {
        id: "model",
        category: "model",
        name: "Model",
        type: "select",
        currentValue: wireModel,
        options: [{ value: wireModel, name: "Chosen" }],
      },
    ],
  };
  const input = { agentId: "chosen", cwd: result.cwd, service };
  const value = openedThreadState(input, result, null);
  const missingMapping = openedThreadState(
    input,
    { ...result, serviceModelValue: undefined },
    null,
  );
  expect(() =>
    configurationRestoreIntent(missingMapping, {}, logicalModel),
  ).toThrow();
  expect(configurationRestoreIntent(value, {}, logicalModel)).toEqual({
    model: wireModel,
  });
  expect(
    configurationRestoreIntent(value, { model: wireModel }, logicalModel),
  ).toEqual({ model: wireModel });
  expect(() =>
    configurationRestoreIntent(value, { model: alternative }, logicalModel),
  ).toThrow();
  expect(() => configurationRestoreIntent(value, {}, "other/model")).toThrow();
  value.configOptions[0].currentValue = alternative;
  expect(() => configurationRestoreIntent(value, {}, logicalModel)).toThrow();
});
it.each(["thought-only", "service-model"])(
  "confirms the original %s intent without a setter",
  async (kind) => {
    const value = state();
    if (kind === "thought-only")
      value.configOptions = value.configOptions.filter(
        (item) => item.id !== "model",
      );
    const selection =
      kind === "thought-only"
        ? { thought: "medium" }
        : configurationRestoreIntent(value, {}, "chosen-model");
    const confirm = vi.fn().mockResolvedValue(undefined),
      set = vi.fn();
    await expect(
      restoreSavedConfiguration(value, selection, {
        current: () => true,
        validateService: async () => {},
        set,
        confirm,
      }),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(selection);
    expect(set).not.toHaveBeenCalled();
  },
);
it.each(["service-failed", "owner-retired"])(
  "does not confirm after %s or change the original map",
  async (kind) => {
    const value = state(),
      saved = { thought: "medium" },
      confirm = vi.fn();
    let current = true;
    const result = restoreSavedConfiguration(value, saved, {
      current: () => current,
      set: vi.fn(),
      confirm,
      validateService: async () => {
        if (kind === "service-failed") throw new Error("controlled");
        current = false;
      },
    });
    if (kind === "service-failed")
      await expect(result).rejects.toThrow("controlled");
    else await expect(result).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(saved).toEqual({ thought: "medium" });
  },
);
