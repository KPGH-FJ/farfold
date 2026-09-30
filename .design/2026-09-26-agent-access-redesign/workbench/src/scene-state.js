import { AGENT_CATALOG } from "./agent-catalog.js";
import { WORKSPACE_TASKS } from "./workspace-scenarios.js";
import { TASKS_V2, GROUPS, SERVICES_V2 } from "./data-v2.js";

// Fresh opening and explicit reset use this baseline. Restored work is retained.
export function firstUseAgents(catalog = AGENT_CATALOG) {
  return structuredClone(catalog).map((agent) => ({
    ...agent,
    added: false,
    registered: false,
    available: false,
    discovered: Boolean(agent.discovered || agent.installed),
    connected: false,
    connectionState: "idle",
    setupComplete: false,
    onboardingComplete: false,
    demoReady: false,
    setupDraft: undefined,
  }));
}

export function firstUseState() {
  return {
    scene: "first",
    view: "new",
    active: null,
    tasks: [],
    groups: [],
    services: [],
    agents: firstUseAgents(),
    authBlocks: {},
    workPolicies: {},
    archiveDays: "30",
    draft: {
      text: "",
      files: [],
      folder: "",
      choice: {
        agent: "",
        model: "",
        source: "沿用已有设置",
        accessMode: "existing",
      },
    },
  };
}

// Explicit demonstration replacement; never applied during opening or restart.
export function exampleState() {
  const fresh = firstUseState();
  const tasks = structuredClone([...TASKS_V2, ...WORKSPACE_TASKS]);
  const names = new Set(tasks.map((task) => task.agent));
  return {
    ...fresh,
    scene: "examples",
    view: "conversations",
    tasks,
    groups: structuredClone(GROUPS),
    services: structuredClone(SERVICES_V2),
    agents: fresh.agents.map((agent) =>
      names.has(agent.name)
        ? structuredClone(AGENT_CATALOG.find((entry) => entry.id === agent.id))
        : agent,
    ),
  };
}
