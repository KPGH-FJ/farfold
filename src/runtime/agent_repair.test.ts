import { expect, it } from "vitest";
import {
  agentRepairPanel,
  conversationRepairContext,
  locateAgentRepair,
} from "./agent_repair";
import { freshThreadState } from "./session_projection";
import type { AgentSetupProgress } from "../components/AgentSetup";

it("routes only known authentication, source and model errors to their repair panels", () => {
  const thread = freshThreadState("old", "agent", "/work", "native");
  expect(agentRepairPanel(undefined, false)).toBe("program");
  thread.configError = "config failed";
  expect(agentRepairPanel(thread, false)).toBe("model");
  thread.configError = null;
  thread.modelDrift = true;
  expect(agentRepairPanel(thread, false)).toBe("model");
  thread.sourceError = true;
  expect(agentRepairPanel(thread, false)).toBe("account");
  expect(agentRepairPanel(undefined, true)).toBe("account");
});

it("locates repairs without replacing an unfinished API selection", () => {
  const progress: AgentSetupProgress = {
    step: 2,
    choice: "api",
    authMethodId: "official",
    selection: {
      service: { id: "chosen", model: "model", revision: "revision" },
      config: { model: "model", reasoning: "ultra" },
    },
  };
  const next = locateAgentRepair(progress, {
    panel: "account",
    needsAuthentication: true,
  });
  expect(next).toEqual({ ...progress, step: 1 });
  expect(next.selection).toBe(progress.selection);
  expect(locateAgentRepair(progress, { panel: "program" })).toEqual({
    ...progress,
    step: 0,
  });
});

it("chooses login only for confirmed authentication required on existing settings", () => {
  const progress: AgentSetupProgress = {
    step: 0,
    choice: "existing",
    selection: { service: null, config: { model: "chosen" } },
  };
  expect(
    locateAgentRepair(progress, {
      panel: "account",
      needsAuthentication: true,
    }),
  ).toEqual({ ...progress, step: 1, choice: "login" });
  expect(locateAgentRepair(progress, { panel: "account" }).choice).toBe(
    "existing",
  );
  expect(
    locateAgentRepair(progress, {
      panel: "account",
      needsAuthentication: true,
      sourceContext: "api-official-context",
    }).choice,
  ).toBe("existing");
});

it("keeps the original conversation source and detached model evidence", () => {
  const thread = freshThreadState("old", "agent", "/work", "native");
  thread.service = { id: "api", model: "model", fingerprint: "fingerprint" };
  thread.serviceContext = "official-service-context";
  thread.recordedModel = "original-model";
  thread.configOptions = [
    {
      id: "model",
      type: "select",
      name: "Model",
      currentValue: "model",
      options: [{ value: "model", name: "Model" }],
    },
  ];
  const context = conversationRepairContext(thread);
  expect(context).toEqual({
    key: thread.key,
    service: thread.service,
    sourceContext: "official-service-context",
    configOptions: thread.configOptions,
    recordedModel: "original-model",
  });
  expect(context.configOptions).not.toBe(thread.configOptions);
  expect(context.service).not.toBe(thread.service);
  thread.serviceContext = undefined;
  expect(conversationRepairContext(thread).sourceContext).toBe(
    JSON.stringify(thread.service),
  );
});

it("carries detached original protected IDs into the existing-conversation review", () => {
  const thread = freshThreadState(
    "protected-review",
    "agent",
    "/work",
    "native",
  );
  thread.configCheck = {
    status: "ready",
    issues: [],
    protectedIds: ["original-depth"],
    current: { choices: [] },
  };
  const context = conversationRepairContext(thread);
  expect(context.protectedIds).toEqual(["original-depth"]);
  expect(context.protectedIds).not.toBe(thread.configCheck.protectedIds);
  thread.configCheck.protectedIds!.push("later");
  expect(context.protectedIds).toEqual(["original-depth"]);
});
