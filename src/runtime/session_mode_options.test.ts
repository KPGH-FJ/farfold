import { expect, it } from "vitest";
import { openedThreadState } from "./session_open_state";
import {
  applyUpdate,
  normalizeConfigOptions,
  replaceConfigOptions,
} from "./session_projection";

const modes = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask" },
    { id: "act", name: "Act" },
  ],
};
const legacyModel = {
  id: "__farfold_legacy_model",
  category: "model",
  type: "select",
  name: "Model",
  currentValue: "original-model",
  options: [{ value: "original-model", name: "Original model" }],
};
const modern = [
  {
    id: "mode",
    category: "mode",
    type: "select",
    name: "Mode",
    currentValue: "act",
    options: [{ value: "act", name: "Act" }],
  },
  {
    id: "autoApprove",
    category: "mode",
    type: "boolean",
    name: "Auto Approve",
    currentValue: false,
  },
  {
    id: "yolo",
    category: "mode",
    type: "boolean",
    name: "YOLO",
    currentValue: true,
  },
  {
    id: "other-mode",
    category: "mode",
    type: "select",
    name: "Other mode",
    currentValue: "other",
    options: [{ value: "other", name: "Other" }],
  },
  {
    id: "future-mode",
    category: "mode",
    type: "future",
    name: "Future mode",
    currentValue: { opaque: true },
  },
];

function open(configOptions: unknown, configOptionsModern?: boolean) {
  return openedThreadState(
    { agentId: "mode-fixture", cwd: "/mode-fixture" },
    {
      nativeSessionId: "existing",
      cwd: "/mode-fixture",
      configOptions,
      configOptionsModern,
      modes,
      resumed: true,
      warnings: [],
    },
    "Original title",
  );
}

function updateMode(state: ReturnType<typeof open>) {
  applyUpdate(state, {
    sessionUpdate: "current_mode_update",
    currentModeId: "act",
  });
}

it("updates the synthesized legacy mode without changing the legacy model", () => {
  const state = open([legacyModel], false);
  const model = structuredClone(state.configOptions[0]);
  expect(state.modesSeparate).toBe(true);
  expect(state.configOptions.map(({ id }) => id)).toEqual([
    "__farfold_legacy_model",
    "mode",
  ]);
  updateMode(state);
  expect(state.currentModeId).toBe("act");
  expect(state.configOptions[1].currentValue).toBe("act");
  expect(state.configOptions[0]).toEqual(model);
});

it("keeps modern repeated mode declarations and boolean values unchanged by a legacy notification", () => {
  const state = open(modern);
  const before = structuredClone(state.configOptions);
  expect(state.modesSeparate).toBe(false);
  updateMode(state);
  expect(state.currentModeId).toBeNull();
  expect(state.configOptions).toEqual(before);
  expect(state.configOptions).toEqual(normalizeConfigOptions(modern));
});

it("preserves the synthetic legacy control across a legacy model-only update", () => {
  const state = open([legacyModel], false);
  const mode = structuredClone(state.configOptions[1]);
  replaceConfigOptions(state, normalizeConfigOptions([legacyModel]), false);
  expect(state.modesSeparate).toBe(true);
  expect(state.configOptions[1]).toEqual(mode);
  updateMode(state);
  expect(state.configOptions[1].currentValue).toBe("act");
});

it.each([
  ["complete repeated categories", modern],
  ["empty modern list", []],
  ["boolean with the exact mode id", [{ ...modern[1], id: "mode" }]],
  ["unknown with the exact mode id", [{ ...modern[4], id: "mode" }]],
])(
  "lets a %s supersede the legacy surface without merging or changing values",
  (_, options) => {
    const state = open([legacyModel], false);
    const expected = normalizeConfigOptions(options);
    replaceConfigOptions(state, expected);
    const before = structuredClone(state.configOptions);
    expect(state.modesSeparate).toBe(false);
    updateMode(state);
    expect(state.configOptions).toEqual(before);
    expect(state.configOptions).toEqual(expected);
  },
);
