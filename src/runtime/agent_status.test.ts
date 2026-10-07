import { describe, expect, it } from "vitest";
import { agentStatus, type AgentStatusInput } from "./agent_status";
import type { AgentCardModel } from "./agents";
import { ACCESS_STRINGS as S } from "./access_strings";
import { PREPARATION_ACTION_STRINGS as C } from "./preparation_action_strings";

const card: AgentCardModel = {
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
  platformAvailable: true,
};

const entry = (
  input: Omit<Partial<AgentStatusInput>, "card"> & {
    card?: Partial<AgentCardModel>;
  },
): [string, AgentStatusInput] => [
  JSON.stringify(input),
  { ...input, card: { ...card, ...input.card } },
];

describe("agentStatus shared mapping", () => {
  it.each([
    entry({ progressLabel: "正在安装…" }),
    entry({ accountInProgress: true }),
    entry({ accountInProgress: true, configuring: true }),
    entry({ readRequired: true }),
    entry({ authRequired: true }),
    entry({ card: { status: "connected" }, prepared: true }),
    entry({ card: { status: "installed" }, prepared: true }),
    entry({ card: { status: "connected" } }),
    entry({ card: { status: "installed" } }),
    entry({
      card: { status: "connected", connectionFailed: true },
      prepared: true,
    }),
    entry({ card: { status: "discovered" } }),
    entry({ card: { installable: false, registerable: false } }),
    entry({
      card: {
        installable: false,
        registerable: false,
        platformAvailable: false,
      },
    }),
    entry({}),
  ] as const)("maps %s", (_key, input) => {
    expect(agentStatus(input)).toMatchSnapshot();
  });

  it("keeps progress, account and read activity ahead of every card state", () => {
    const busy: AgentStatusInput = {
      card: { ...card, status: "connected", connectionFailed: true },
      progressLabel: "正在连接…",
      authRequired: true,
      prepared: true,
    };
    expect(agentStatus(busy)).toEqual({
      tone: "progress",
      label: "正在连接…",
    });
    expect(
      agentStatus({ ...busy, progressLabel: null, accountInProgress: true }),
    ).toEqual({ tone: "progress", label: S.loginInProgress });
    expect(
      agentStatus({
        ...busy,
        progressLabel: null,
        accountInProgress: true,
        configuring: true,
      }),
    ).toEqual({ tone: "progress", label: C.inProgress });
    expect(
      agentStatus({ ...busy, progressLabel: null, readRequired: true }),
    ).toEqual({ tone: "progress", label: C.readPending });
    expect(agentStatus({ ...busy, progressLabel: null })).toEqual({
      tone: "attention",
      label: S.needLogin,
    });
  });
});
