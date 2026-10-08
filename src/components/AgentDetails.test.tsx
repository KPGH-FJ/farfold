import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { AgentDetails, declaredCapabilities } from "./AgentDetails";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { AGENT_DETAIL_STRINGS as D } from "../runtime/agent_detail_strings";

const base: AgentCardModel = {
  id: "a",
  name: "Agent A",
  description: "",
  status: "installed",
  version: "1.2.3",
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "registry",
  installable: true,
  registerable: false,
  custom: false,
  handshake: null,
};
const agents = { errors: {} } as unknown as AgentsState;
function html(card: AgentCardModel) {
  return renderToStaticMarkup(
    <AgentDetails
      card={card}
      agents={agents}
      active
      source="目录"
      onClose={() => {}}
      onPrepare={() => {}}
    />,
  );
}

it("reads only declared capability fields from the stored handshake", () => {
  const card: AgentCardModel = {
    ...base,
    handshake: {
      authMethods: [
        { id: "oauth", name: "账号登录", type: "agent" },
        { id: "key" },
      ],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        auth: { logout: {} },
      },
    },
  };
  expect(declaredCapabilities(card)).toEqual({
    authMethods: [
      { id: "oauth", name: "账号登录", type: "agent" },
      { id: "key" },
    ],
    loadSession: true,
    prompt: { image: true, audio: false, embeddedContext: true },
    logout: true,
    known: true,
  });
  expect(declaredCapabilities(base)).toEqual({
    authMethods: [],
    loadSession: null,
    prompt: { image: false, audio: false, embeddedContext: false },
    logout: false,
    known: false,
  });
  // A handshake without loadSession is an explicit no, not unknown.
  expect(
    declaredCapabilities({ ...base, handshake: { agentCapabilities: {} } })
      .loadSession,
  ).toBe(false);
});

it("presents declared capabilities honestly without protocol internals", () => {
  const card: AgentCardModel = {
    ...base,
    status: "connected",
    handshake: {
      authMethods: [{ id: "oauth", name: "账号登录" }],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        auth: { logout: {} },
      },
    },
  };
  const markup = html(card);
  expect(markup).toContain(D.capabilities);
  expect(markup).toContain("账号登录");
  expect(markup).toContain(D.capabilityPromptImage);
  expect(markup).toContain(D.capabilityHistoryDeclared);
  // API capability stays honest while the live result is unread.
  expect(markup).toContain(D.capabilityApiUnknown);
  expect(markup).toContain(D.capabilityHonesty);
  // Internal mechanism names never reach the page.
  for (const forbidden of ["loadSession", "promptCapabilities", "handshake"])
    expect(markup).not.toContain(forbidden);
});

it("falls back to unknown wording when no declaration exists", () => {
  const markup = html(base);
  expect(markup).toContain(D.capabilityAuthUnknown);
  expect(markup).toContain(D.capabilityHistoryUnknown);
  expect(markup).toContain(D.capabilityContentNone);
});
