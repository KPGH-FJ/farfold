import { describe, expect, it } from "vitest";
import {
  agentStatusLabel,
  customAgentCard,
  mergeAgentCards,
  toAgentCard,
  type AgentConnectionStatus,
  type AgentRow,
  type CatalogEntry,
} from "./agents";

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    agentId: "codex",
    displayName: "Codex",
    description: "OpenAI coding assistant",
    registryId: "codex-acp",
    installLaunch: {
      kind: "npx",
      package: "@agentclientprotocol/codex-acp",
      args: [],
    },
    discovered: null,
    registered: null,
    registryVersion: "1.12.0",
    installable: true,
    ...overrides,
  };
}

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "custom-my-agent",
    name: "My Agent",
    source: "custom",
    command: "/usr/local/bin/my-agent",
    args: ["--acp"],
    env: [],
    version: "0.3.0",
    handshake: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function readyStatus(
  overrides: Partial<AgentConnectionStatus> = {},
): AgentConnectionStatus {
  return {
    agentId: "codex",
    cwd: "/Users/tw",
    state: "ready",
    agentName: "codex-acp",
    agentVersion: "1.12.0",
    authMethods: ["chatgpt", "api-key"],
    ...overrides,
  };
}

describe("toAgentCard", () => {
  it("maps the four status tiers", () => {
    expect(toAgentCard(catalogEntry(), undefined).status).toBe("none");

    const discovered = toAgentCard(
      catalogEntry({
        discovered: {
          agentId: "codex",
          path: "/opt/homebrew/bin/codex",
          version: "0.55.0",
        },
      }),
      undefined,
    );
    expect(discovered.status).toBe("discovered");
    expect(discovered.version).toBe("0.55.0");
    expect(discovered.registerable).toBe(false);

    const installed = toAgentCard(
      catalogEntry({
        discovered: null,
        registered: agentRow({
          id: "codex",
          source: "registry",
          version: "1.12.0",
        }),
      }),
      undefined,
    );
    expect(installed.status).toBe("installed");
    expect(installed.version).toBe("1.12.0");

    const connected = toAgentCard(
      catalogEntry({ registered: agentRow({ id: "codex" }) }),
      [readyStatus()],
    );
    expect(connected.status).toBe("connected");
    expect(connected.version).toBe("1.12.0");
    expect(connected.authMethods).toEqual(["chatgpt", "api-key"]);
  });

  it("marks binary-launch discovered agents as registerable", () => {
    const card = toAgentCard(
      catalogEntry({
        agentId: "opencode",
        installLaunch: {
          kind: "binary",
          binary: "opencode",
          args: ["acp"],
        },
        discovered: {
          agentId: "opencode",
          path: "/Users/tw/.opencode/bin/opencode",
          version: "1.15.13",
        },
      }),
      undefined,
    );
    expect(card.status).toBe("discovered");
    expect(card.registerable).toBe(true);
    expect(agentStatusLabel(card)).toBe("已发现 1.15.13");
  });

  it("uses the current discovered binary version for registered binary agents", () => {
    const card = toAgentCard(
      catalogEntry({
        agentId: "opencode",
        installLaunch: {
          kind: "binary",
          binary: "opencode",
          args: ["acp"],
        },
        discovered: {
          agentId: "opencode",
          path: "/Users/tw/.opencode/bin/opencode",
          version: "1.18.31",
        },
        registered: agentRow({
          id: "opencode",
          source: "discovered",
          command: "/Users/tw/.opencode/bin/opencode",
          version: "1.15.13",
        }),
      }),
      undefined,
    );
    expect(card.status).toBe("installed");
    expect(agentStatusLabel(card)).toBe("已安装 1.18.31");
  });
});

describe("mergeAgentCards", () => {
  it("appends registered custom rows the catalog does not cover", () => {
    const cards = mergeAgentCards([catalogEntry()], [agentRow()], {
      "custom-my-agent": [readyStatus({ agentId: "custom-my-agent" })],
    });
    expect(cards).toHaveLength(2);
    const custom = cards[1];
    expect(custom.custom).toBe(true);
    expect(custom.status).toBe("connected");
    expect(agentStatusLabel(custom)).toBe("已连接 1.12.0");
  });

  it("customAgentCard falls back to installed without a live connection", () => {
    const card = customAgentCard(agentRow(), []);
    expect(card.status).toBe("installed");
    expect(card.version).toBe("0.3.0");
    expect(agentStatusLabel(card)).toBe("已安装 0.3.0");
  });
});
