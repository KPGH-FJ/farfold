import { describe, expect, it } from "vitest";
import type { AgentCardModel } from "./agents";
import { AGENT_BRANDS } from "./agent_brands";
import {
  agentDirectoryDescription,
  agentDirectorySource,
  matchesAgentDirectory,
  agentDirectoryCategories,
  isAgentPresentable,
  isAgentReadyForConversation,
  presentableAgents,
} from "./agent_directory";

const card: AgentCardModel = {
  id: "unfamiliar-agent",
  name: "Unfamiliar Agent",
  description: "Unverified research claims with Agent 接入 mixed in",
  status: "none",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: null,
  installable: false,
  registerable: false,
  custom: false,
  handshake: null,
};

describe("generic directory presentation", () => {
  it("offers prepared registered entries while offline, including custom programs", () => {
    for (const status of ["none", "discovered"] as const) {
      expect(isAgentReadyForConversation({ ...card, status }, true)).toBe(
        false,
      );
      expect(
        isAgentReadyForConversation({ ...card, status, custom: true }, true),
      ).toBe(false);
    }
    const connected = { ...card, status: "connected" as const };
    expect(
      isAgentReadyForConversation({ ...card, status: "installed" }, true),
    ).toBe(true);
    expect(
      isAgentReadyForConversation({ ...card, status: "installed" }, false),
    ).toBe(false);
    expect(isAgentReadyForConversation(connected, false)).toBe(false);
    expect(isAgentReadyForConversation(connected, true)).toBe(true);
    expect(
      isAgentReadyForConversation(
        { ...connected, firstBatchVisible: false },
        true,
      ),
    ).toBe(false);
    expect(
      isAgentReadyForConversation(
        { ...connected, firstBatchVisible: false, custom: true },
        true,
      ),
    ).toBe(true);
  });
  it("removes retired catalog rows from daily choices without changing cards used by history", () => {
    const retired: AgentCardModel = {
      ...card,
      source: "registry",
      status: "connected",
      firstBatchVisible: false,
    };
    const current = { ...retired, id: "current", firstBatchVisible: true };
    const cards = [retired, current];
    expect(presentableAgents(cards)).toEqual([current]);
    expect(cards).toEqual([retired, current]);
    expect(cards[0]).toBe(retired);
    expect(isAgentPresentable({ ...retired, status: "installed" })).toBe(false);
    expect(retired.status).toBe("connected");
  });

  it("keeps explicit custom and local discovery choices when catalog admission is unavailable", () => {
    const outside: AgentCardModel = {
      ...card,
      firstBatchVisible: false,
      status: "installed",
    };
    for (const retained of [
      { ...outside, custom: true },
      { ...outside, source: "custom" as const },
      { ...outside, source: "discovered" as const },
      { ...outside, status: "discovered" as const },
    ])
      expect(isAgentPresentable(retained)).toBe(true);
  });

  it("filters only sourced categories and combines search without treating them as readiness", () => {
    const reviewed: AgentCardModel = {
      ...card,
      presentation: {
        publisher: "Example Project",
        description: "精简的编程工具。",
        categories: ["编程", "轻量"],
        sourceUrl: "https://example.test/official",
      },
    };
    expect(agentDirectoryDescription(reviewed)).toBe("精简的编程工具。");
    expect(agentDirectorySource(reviewed)).toBe("Example Project");
    expect(matchesAgentDirectory(reviewed, "example", "轻量")).toBe(true);
    expect(matchesAgentDirectory(reviewed, "different", "轻量")).toBe(false);
    expect(matchesAgentDirectory(reviewed, "", "研究")).toBe(false);
    expect(matchesAgentDirectory(card, "", "研究")).toBe(false);
    expect(matchesAgentDirectory(card, "research", "全部")).toBe(true);
    expect(agentDirectoryCategories({ ...reviewed, custom: true })).toEqual([]);
    expect(reviewed.status).toBe("none");
  });
  it("uses reviewed Chinese introductions for known identities and keeps external prose out of unknown summaries", () => {
    const plain = agentDirectoryDescription(card);
    expect(plain).toBe("查看官方说明，或添加已安装的程序。");
    expect(
      agentDirectoryDescription({ ...card, id: "codex", name: "Codex" }),
    ).toBe(AGENT_BRANDS["codex-acp"].description);
    expect(plain).not.toContain("research");
    expect(matchesAgentDirectory(card, "research")).toBe(true);
    expect(matchesAgentDirectory(card, "  UNFAMILIAR  ")).toBe(true);
    expect(matchesAgentDirectory(card, "已安装")).toBe(true);
    expect(matchesAgentDirectory(card, "unrelated category")).toBe(false);
  });

  it("keeps the same introduction across discovery and management without claiming readiness", () => {
    for (const id of Object.keys(AGENT_BRANDS)) {
      for (const status of [
        "none",
        "discovered",
        "installed",
        "connected",
      ] as const) {
        const entry: AgentCardModel = {
          ...card,
          id: `registry:${id}`,
          status,
          presentation: {
            publisher: "Publisher",
            description: "旧说明",
            categories: [],
            sourceUrl: "https://example.test",
          },
        };
        expect(agentDirectoryDescription(entry)).toBe(
          AGENT_BRANDS[id].description,
        );
        expect(entry.status).toBe(status);
      }
    }
    expect(
      agentDirectoryDescription({ ...card, id: "codex", custom: true }),
    ).not.toBe(AGENT_BRANDS["codex-acp"].description);
  });

  it("shows a real web source location without inferring a publisher or showing credentials", () => {
    expect(agentDirectorySource(card)).toBeNull();
    expect(
      agentDirectorySource({
        ...card,
        sourceUrl: "https://user:secret@www.example.test/repo",
      }),
    ).toBe("example.test");
    expect(
      agentDirectorySource({ ...card, sourceUrl: "file:///tmp/program" }),
    ).toBeNull();
    expect(
      agentDirectorySource({ ...card, sourceUrl: "not a url" }),
    ).toBeNull();
    expect(
      agentDirectorySource({
        ...card,
        installGuide: "https://docs.example.test/setup",
      }),
    ).toBe("docs.example.test");
  });
});
