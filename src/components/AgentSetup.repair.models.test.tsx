import {
  h,
  card,
  props,
  render,
  confirmModelRead,
  programConnect,
} from "./AgentSetup.repair.test-support";
import { expect, it, vi } from "vitest";
import {
  initialAgentSetupProgress,
  type AgentSetupProgress,
} from "./AgentSetup";
import { AgentSetupNavigation } from "./AgentSetupNavigation";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentPrerequisites } from "./AgentPrerequisites";
import type { AgentsState } from "../runtime/agents";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { AGENT_SETUP_STRINGS as M } from "../runtime/agent_setup_strings";
import { preparationProgram } from "../runtime/agent_preparation";
import { freshThreadState } from "../runtime/session_projection";

it("reads models for a connected first-use entry and returns its choice without a required test", async () => {
  props.intent = "use";
  props.conversation = undefined;
  const selection = {
    service: null,
    config: { model: "chosen", reasoning: "ultra" },
  };
  props.progress = initialAgentSetupProgress(selection, true);
  let nodes = render();
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(2);
  expect(nodes.some((node) => node.props.role === "radio")).toBe(false);
  const prerequisites = nodes.find((node) => node.type === AgentPrerequisites)!;
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
  nodes = render();
  expect(h.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentId: card.id,
      cwd: "/old",
      service: null,
      config: selection.config,
    }),
  );
  expect(props.onStart).not.toHaveBeenCalled();
  expect(
    nodes.find(
      (node) =>
        node.type === "button" && node.props.children === S.useSelection,
    )!.props.disabled,
  ).toBe(true);
  confirmModelRead();
  nodes = render();
  const finish = nodes.find(
    (node) => node.type === "button" && node.props.children === S.useSelection,
  )!;
  expect(finish.props.disabled).toBe(false);
  await (finish.props.onClick as () => Promise<void>)();
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith(card.id, selection);
});

it.each([
  [false, true],
  [true, true],
  [false, false],
])(
  "distinguishes a read failure from a later test failure (explicit: %s, read failure: %s)",
  async (explicit, failedRead) => {
    props.conversation = undefined;
    props.intent = "use";
    const selection = { service: null, config: { model: "chosen" } };
    props.progress = initialAgentSetupProgress(selection, true);
    const { preparationProgram } = await import("../runtime/agent_preparation");
    const { freshThreadState } = await import("../runtime/session_projection");
    const thread = freshThreadState("failed-read", card.id, "/old", "failure");
    thread.identity = "draft";
    thread.sourceError = failedRead;
    thread.configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "chosen",
        options: [],
      },
    ];
    if (failedRead)
      thread.configOptions.push({
        id: "mode",
        name: "Thinking",
        type: "select",
        currentValue: "on",
        options: [],
      });
    h.thread = thread;
    h.preparation = {
      phase: "failed",
      input: {
        agentId: card.id,
        agentName: card.name,
        cwd: "/old",
        program: preparationProgram(card),
        service: null,
        config: selection.config,
      },
      threadKey: thread.key,
      config: Object.fromEntries(
        thread.configOptions.map((option) => [option.id, option.currentValue]),
      ),
      prompt: "",
      reply: "",
      error: failedRead ? S.testPrepareFailed : S.testFailed,
      readError: failedRead ? S.testPrepareFailed : null,
      explicitReadTargets: explicit
        ? [JSON.stringify([card.id, "/old", null])]
        : [],
    };
    const nodes = render();
    expect(nodes.some((node) => node.props.children === M.modelFailed)).toBe(
      failedRead,
    );
    expect(nodes.some((node) => node.props.children === M.modelReady)).toBe(
      !failedRead,
    );
    expect(
      nodes.some(
        (node) =>
          node.props.role === "alert" &&
          node.props.children === S.testPrepareFailed,
      ),
    ).toBe(failedRead);
    expect(props.progress?.selection).toEqual(selection);
    expect(h.prepare).not.toHaveBeenCalled();
  },
);

it("uses the same canonical configuration target for explicit model reading without changing the displayed folder", () => {
  props.conversation = undefined;
  props.intent = "use";
  props.cwd = "/tmp/project-alias";
  h.canonical = "/private/tmp/project-alias";
  props.progress = initialAgentSetupProgress(
    { service: null, config: { model: "chosen", mode: "off" } },
    true,
  );
  h.preparation = {
    phase: "stale",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: null,
    explicitReadTargets: [JSON.stringify([card.id, h.canonical, null])],
  };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  expect(h.prepare).not.toHaveBeenCalled();
  const read = nodes.find(
    (node) => node.type === "button" && node.props.children === M.modelRetry,
  )!;
  expect(read.props.disabled).toBe(false);
  (read.props.onClick as () => void)();
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: h.canonical,
      config: { model: "chosen", mode: "off" },
    }),
    true,
  );
  expect(props.cwd).toBe("/tmp/project-alias");
});

it("shows a failed restoration without replacing the caller's choices or hiding it as unread", async () => {
  props.conversation = undefined;
  props.intent = "use";
  const selection = {
    service: null,
    config: { model: "chosen", thought_level: "off", mode: "off" },
  };
  props.progress = initialAgentSetupProgress(selection, true);
  const { preparationProgram } = await import("../runtime/agent_preparation");
  h.preparation = {
    phase: "failed",
    input: {
      agentId: card.id,
      agentName: card.name,
      cwd: "/old",
      program: preparationProgram(card),
      service: null,
      config: selection.config,
    },
    threadKey: "returned-draft",
    config: { model: "chosen", thought_level: "off", mode: "different" },
    prompt: "",
    reply: "",
    error: S.testSelectionNotApplied,
  };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  expect(
    nodes.some(
      (node) =>
        node.props.role === "alert" &&
        node.props.children === S.testSelectionNotApplied,
    ),
  ).toBe(true);
  expect(nodes.some((node) => node.props.children === M.modelPending)).toBe(
    false,
  );
  expect(props.progress?.selection).toEqual(selection);
  expect(
    nodes.find(
      (node) =>
        node.type === "button" && node.props.children === S.useSelection,
    )?.props.disabled,
  ).toBe(true);
  const retry = nodes.find(
    (node) => node.type === "button" && node.props.children === M.modelRetry,
  )!;
  expect(retry.props.disabled).toBe(false);
  (retry.props.onClick as () => void)();
  expect(h.prepare).toHaveBeenLastCalledWith(
    expect.objectContaining({ config: selection.config }),
    true,
  );
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps the shared explicit-read requirement across leaving and returning to model selection", () => {
  props.conversation = undefined;
  props.intent = "use";
  const selection = {
    service: null,
    config: { model: "chosen", reasoning: "high" },
  };
  props.progress = initialAgentSetupProgress(selection, true);
  h.preparation = {
    phase: "stale",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: null,
    explicitReadTargets: [JSON.stringify([card.id, "/old", null])],
  };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  expect(h.prepare).not.toHaveBeenCalled();
  props.active = false;
  render();
  props.active = true;
  nodes = render();
  expect(h.prepare).not.toHaveBeenCalled();
  const read = nodes.find(
    (node) => node.type === "button" && node.props.children === M.modelRetry,
  )!;
  expect(read.props.disabled).toBe(false);
  (read.props.onClick as () => void)();
  expect(h.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ cwd: "/old", config: selection.config }),
    true,
  );
  expect(props.progress?.selection).toEqual(selection);
  expect(props.onStart).not.toHaveBeenCalled();
});

it("verifies saved settings in place and advances to models when the read succeeds", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = {
    step: 1,
    choice: "existing",
    selection: { service: null, config: { model: "A" } },
  };
  props.agents = {
    ...props.agents,
    statuses: {
      [card.id]: [
        {
          connectionId: "preparation-1",
          purpose: "preparation",
          agentId: card.id,
          cwd: "/old",
          state: "ready",
          agentName: null,
          agentVersion: null,
          authMethods: [],
        },
      ],
    } as AgentsState["statuses"],
  };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  const section = nodes.find((node) => node.type === AgentAuthSection)!;
  (
    section.props.connection as {
      onUseExisting: () => void;
      existingVerify?: { status: string };
    }
  ).onUseExisting();
  nodes = render();
  expect(props.progress.accessStage).toBe("account");
  expect(h.prepare).toHaveBeenCalledOnce();
  const verifying = nodes.find((node) => node.type === AgentAuthSection)!;
  expect(
    (
      verifying.props.connection as {
        existingVerify?: { status: string };
      }
    ).existingVerify?.status,
  ).toBe("checking");
  confirmModelRead();
  render();
  expect(props.progress.step).toBe(2);
  expect(props.onStart).not.toHaveBeenCalled();
});

it("resumes a saved model step after reconnect without resetting its source or choices", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.card = { ...card, status: "installed" };
  const saved: AgentSetupProgress = {
    step: 2,
    choice: "existing",
    selection: {
      service: null,
      config: { model: "chosen", thought_level: "off" },
    },
  };
  props.progress = saved;
  props.agents = { ...props.agents, connect: vi.fn(async () => true) };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  const connect = programConnect(render());
  (connect.props.onClick as () => void)();
  await Promise.resolve();
  props.card = { ...props.card, status: "connected" };
  render();
  nodes = render();
  expect(props.progress).toEqual(saved);
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(2);
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ config: saved.selection!.config }),
  );
  expect(props.onStart).not.toHaveBeenCalled();
});
