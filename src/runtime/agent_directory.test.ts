import { describe, expect, it } from "vitest";
import type { AgentCardModel } from "./agents";
import {
  agentDirectoryDescription,
  agentDirectorySource,
  matchesAgentDirectory,
  agentDirectoryCategories,
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
  it("does not turn external prose or a recognized brand into Chinese capability claims", () => {
    const plain = agentDirectoryDescription(card);
    expect(plain).toBe("查看官方说明，或添加已安装的程序。");
    expect(
      agentDirectoryDescription({ ...card, id: "codex", name: "Codex" }),
    ).toBe(plain);
    expect(plain).not.toContain("research");
    expect(matchesAgentDirectory(card, "research")).toBe(true);
    expect(matchesAgentDirectory(card, "  UNFAMILIAR  ")).toBe(true);
    expect(matchesAgentDirectory(card, "已安装")).toBe(true);
    expect(matchesAgentDirectory(card, "unrelated category")).toBe(false);
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
