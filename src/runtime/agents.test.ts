import { describe, expect, it } from "vitest";
import {
  customAgentCard,
  mergeAgentCards,
  mergeConnectionStatus,
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
  it("passes sourced presentation through without turning category labels into capabilities", () => {
    const presentation = {
      publisher: "Example project",
      description: "公开目录简介",
      categories: ["研究"] as const,
      sourceUrl: "https://example.test/official",
    };
    const card = toAgentCard(
      catalogEntry({
        presentation: {
          ...presentation,
          categories: [...presentation.categories],
        },
        installable: false,
        installLaunch: null,
      }),
      undefined,
    );
    expect(card.presentation).toEqual(presentation);
    expect(card.status).toBe("none");
    expect(card.installable).toBe(false);
    expect(card.registerable).toBe(false);
    expect(card.handshake).toBeNull();
    expect(card.authMethods).toEqual([]);
    expect(toAgentCard(catalogEntry(), undefined).presentation).toBeUndefined();
    expect(
      toAgentCard(catalogEntry({ presentation: null }), undefined).presentation,
    ).toBeNull();
    expect(
      customAgentCard(agentRow({ name: "Codex" }), undefined).presentation,
    ).toBeUndefined();
  });
  it("does not infer official device support from Farfold installation support", () => {
    const unavailable = { installable: false, installLaunch: null };
    expect(
      toAgentCard(catalogEntry(unavailable), undefined).platformAvailable,
    ).toBeUndefined();
    expect(
      toAgentCard(
        catalogEntry({ ...unavailable, platformAvailable: true }),
        undefined,
      ).platformAvailable,
    ).toBe(true);
    expect(
      toAgentCard(
        catalogEntry({ ...unavailable, platformAvailable: false }),
        undefined,
      ).platformAvailable,
    ).toBe(false);
    expect(
      toAgentCard(
        catalogEntry({ ...unavailable, platformAvailable: null }),
        undefined,
      ).platformAvailable,
    ).toBeNull();
  });
  it("keeps published directory metadata without claiming connection or platform support", () => {
    const card = toAgentCard(
      catalogEntry({
        agentId: "registry:example",
        registryId: "example",
        displayName: "Example",
        description: "ACP adapter for Example",
        sourceUrl: "https://example.test",
        icon: "https://example.test/icon.svg",
        installable: false,
        platformAvailable: false,
        installLaunch: null,
      }),
      undefined,
    );
    expect(card.status).toBe("none");
    expect(card.installable).toBe(false);
    expect(card.registryId).toBe("example");
    expect(card.sourceUrl).toBe("https://example.test");
    expect(card.description).not.toMatch(/ACP|adapter/);
    expect(card.description).toBe("Agent 接入 for Example");
    expect(card.registerable).toBe(false);
  });
  it("collapses consecutive translated directory terms without changing unrelated prose", () => {
    for (const [description, expected] of [
      ["ACP adapter sidecar for Example", "Agent 接入 for Example"],
      ["ACP-adapter / sidecar for Example", "Agent 接入 for Example"],
      ["Runtime Host with Session Turn", "环境 with 对话"],
      [
        "An assistant for everyday writing",
        "An assistant for everyday writing",
      ],
    ]) {
      expect(
        toAgentCard(catalogEntry({ description }), undefined).description,
      ).toBe(expected);
    }
  });
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
    expect(card.version).toBe("1.15.13");
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
    expect(card.version).toBe("1.18.31");
  });
});

describe("mergeAgentCards", () => {
  it("retains the true source when an installed directory entry disappears", () => {
    const cards = mergeAgentCards(
      [],
      [agentRow({ id: "registry:example", source: "registry" })],
      {},
    );
    expect(cards[0].source).toBe("registry");
    expect(cards[0].custom).toBe(false);
    expect(cards[0].status).toBe("installed");
    expect(cards[0].installable).toBe(false);
  });
  it("appends registered custom rows the catalog does not cover", () => {
    const cards = mergeAgentCards([catalogEntry()], [agentRow()], {
      "custom-my-agent": [readyStatus({ agentId: "custom-my-agent" })],
    });
    expect(cards).toHaveLength(2);
    const custom = cards[1];
    expect(custom.custom).toBe(true);
    expect(custom.status).toBe("connected");
    expect(custom.version).toBe("1.12.0");
  });

  it("customAgentCard falls back to installed without a live connection", () => {
    const card = customAgentCard(agentRow(), []);
    expect(card.status).toBe("installed");
    expect(card.version).toBe("0.3.0");
  });
});

describe("connection source isolation", () => {
  it("retains the default connection when an API connection in the same project closes", () => {
    const original = readyStatus();
    const api = readyStatus({
      serviceContext: "service-1",
      authMethods: ["api-key"],
    });
    const both = mergeConnectionStatus([original], api);
    expect(both).toHaveLength(2);
    expect(mergeConnectionStatus(both, { ...api, state: "closed" })).toEqual([
      original,
    ]);
  });
  it("does not advertise API connection login methods as brand account methods", () => {
    const api = readyStatus({
      serviceContext: "service-1",
      authMethods: ["api-only"],
    });
    const card = toAgentCard(catalogEntry(), [api]);
    expect(card.status).toBe("connected");
    expect(card.authMethods).toEqual([]);
    expect(
      toAgentCard(catalogEntry(), [api, readyStatus()]).authMethods,
    ).toEqual(["chatgpt", "api-key"]);
  });
});
