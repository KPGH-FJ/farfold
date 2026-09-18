import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentCardModel } from "../runtime/agents";
import { AgentCard, type AgentCardProps } from "./AgentCard";

function card(overrides: Partial<AgentCardModel> = {}): AgentCardModel {
  return {
    id: "opencode",
    name: "OpenCode",
    description: "Open-source coding agent",
    status: "none",
    version: null,
    authMethods: [],
    discoveredPath: null,
    registryVersion: "1.18.31",
    source: null,
    installable: true,
    registerable: false,
    custom: false,
    handshake: null,
    ...overrides,
  };
}

function props(overrides: Partial<AgentCardProps> = {}): AgentCardProps {
  return {
    card: card(),
    busy: null,
    error: null,
    workOn: true,
    confirmRemove: false,
    onConnect() {},
    onDisconnect() {},
    onRemove() {},
    onToggleWork() {},
    ...overrides,
  };
}

describe("AgentCard", () => {
  it("renders a discovered card with a connect action", () => {
    const html = renderToStaticMarkup(
      <AgentCard
        {...props({
          card: card({
            status: "discovered",
            version: "1.15.13",
            discoveredPath: "/Users/tw/.opencode/bin/opencode",
            registerable: true,
          }),
        })}
      />,
    );
    expect(html).toContain("已发现 1.15.13");
    expect(html).toContain(">连接<");
    expect(html).toContain("/Users/tw/.opencode/bin/opencode");
    // Not yet attached: capability rows stay hidden.
    expect(html).not.toContain("在此项目上工作");
  });

  it("renders a connected card with version, login methods and toggles", () => {
    const html = renderToStaticMarkup(
      <AgentCard
        {...props({
          card: card({
            status: "connected",
            version: "1.15.13",
            authMethods: ["oauth", "api-key"],
            source: "discovered",
          }),
        })}
      />,
    );
    expect(html).toContain("已连接 1.15.13");
    expect(html).toContain("登录方式 2 种");
    expect(html).toContain(">断开<");
    expect(html).toContain("在此项目上工作");
    expect(html).toContain("贡献 LifeModel");
    expect(html).toContain("使用 LifeModel");
    expect(html.match(/即将推出/g)).toHaveLength(2);
  });
});
