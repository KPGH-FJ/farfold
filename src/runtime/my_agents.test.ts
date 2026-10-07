import { describe, expect, it, vi } from "vitest";
import type { AgentCardModel } from "./agents";

const h = vi.hoisted(() => ({
  prepared: new Set<string>(),
}));
vi.mock("./setup_storage", () => ({
  setupStorage: {
    completed: (id: string) => h.prepared.has(id),
    confirmedSelection: (id: string) =>
      h.prepared.has(id) ? { service: null, config: {} } : undefined,
  },
  useSetupStorage: () => ({}),
}));

import { isMyAgent } from "./my_agents";

const base: AgentCardModel = {
  id: "agent",
  name: "Agent",
  description: "",
  status: "none",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: null,
  installable: true,
  registerable: true,
  custom: false,
  handshake: null,
};

const cases: [
  string,
  Partial<AgentCardModel>,
  { history?: boolean; prepared?: boolean },
  boolean,
][] = [
  ["installed with no history → mine", { status: "installed" }, {}, true],
  ["connected with no history → mine", { status: "connected" }, {}, true],
  ["custom card → mine", { custom: true, source: "custom" }, {}, true],
  [
    "not added but has history → mine",
    { status: "none" },
    { history: true },
    true,
  ],
  ["saved preparation → mine", { status: "none" }, { prepared: true }, true],
  ["discovered only → not mine", { status: "discovered" }, {}, false],
  [
    "installable catalog entry → not mine",
    { status: "none", source: "registry" },
    {},
    false,
  ],
  [
    "not presentable → not mine",
    {
      status: "installed",
      source: "registry",
      firstBatchVisible: false,
    },
    {},
    false,
  ],
];

describe("isMyAgent shared definition", () => {
  it.each(cases)("%s", (_name, overrides, flags, expected) => {
    h.prepared.clear();
    const card = { ...base, ...overrides };
    if (flags.prepared) h.prepared.add(card.id);
    const history = new Set<string>(flags.history ? [card.id] : []);
    expect(isMyAgent(card, history)).toBe(expected);
  });
});
