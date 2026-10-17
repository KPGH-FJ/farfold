import {
  h,
  card,
  props,
  render,
  confirmModelRead,
  managementDone,
} from "./AgentSetup.repair.test-support";
import { expect, it, vi } from "vitest";
import { AgentSetupNavigation } from "./AgentSetupNavigation";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { ModelPicker } from "./ModelPicker";
import { ServicePicker } from "./ServicePicker";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { WORKSPACE_STRINGS } from "../runtime/workspace_strings";

it("shows every protected choice in an existing conversation without editable controls or source changes", () => {
  props.progress = { ...props.progress, step: 2 };
  props.conversation!.configOptions.push(
    {
      id: "inference_speed",
      category: "model",
      name: "Speed",
      type: "select",
      currentValue: "standard",
      options: [],
    },
    {
      id: "reasoning_effort",
      category: "thought_level",
      name: "Reasoning",
      type: "select",
      currentValue: "medium",
      options: [],
    },
    {
      id: "thinking_budget",
      category: "thought_level",
      name: "Thinking",
      type: "select",
      currentValue: "0",
      options: [],
    },
  );
  const before = structuredClone(props.conversation);
  const nodes = render();
  for (const name of ["Model", "Speed", "Reasoning", "Thinking"])
    expect(
      nodes.some((node) => node.type === "dt" && node.props.children === name),
    ).toBe(true);
  expect(props.conversation).toEqual(before);
  expect(props.onStart).not.toHaveBeenCalled();
  expect(props.onProgress).not.toHaveBeenCalled();
});

it("labels the app-owned default location as an ordinary conversation and retains explicit folders", async () => {
  props.cwd = h.defaultCwd;
  render();
  await Promise.resolve();
  let nodes = render();
  expect(
    nodes.some(
      (node) =>
        node.type === "span" &&
        node.props.title === WORKSPACE_STRINGS.normalConversation,
    ),
  ).toBe(true);
  expect(nodes.some((node) => node.props.title === h.defaultCwd)).toBe(false);
  props.cwd = "/my-project";
  render();
  await Promise.resolve();
  nodes = render();
  expect(
    nodes.some(
      (node) => node.type === "span" && node.props.title === "/my-project",
    ),
  ).toBe(true);
});

it("retains the prior operation while showing the current API source boundary", () => {
  props.card = { ...card, status: "installed" };
  h.authJob = { phase: "completed", checked: false, error: "check failed" };
  const nodes = render();
  const auth = nodes.find((node) => node.type === AgentAuthSection)!;
  expect(auth).toBeDefined();
  expect(auth.props.source).toBe("old-official-api");
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(1);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps old API authentication on its original source and returns to the selected blocker", () => {
  h.required = true;
  const result = render();
  const auth = result.find((node) => node.type === AgentAuthSection)!;
  expect(auth.props.source).toBe("old-official-api");
  expect(
    result.some(
      (node) => node.type === ServicePicker || node.props.role === "radio",
    ),
  ).toBe(false);
  expect(props.onProgress).not.toHaveBeenCalled();
  (auth.props.onOpenConversation as (key: string) => void)("blocking-thread");
  expect(props.onOpenConversation).toHaveBeenCalledWith("blocking-thread");
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
});

it("shows the old model as readonly without preparing another conversation or completing setup", async () => {
  props.progress = { step: 2, choice: "existing" };
  let result = render();
  const prerequisites = result.find((node) => node.type === AgentPrerequisites);
  if (prerequisites)
    (prerequisites.props.onChange as (ready: boolean) => void)(true);
  result = render();
  expect(
    result.some(
      (node) => node.type === ModelPicker || node.type === ServicePicker,
    ),
  ).toBe(false);
  expect(
    result.some(
      (node) => node.type === "dd" && node.props.children === "old-model",
    ),
  ).toBe(true);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
  expect(props.onProgress).not.toHaveBeenCalled();
  const done = result.find(
    (node) =>
      node.type === "button" &&
      node.props.children ===
        (props.conversation ? P.returnConversation : P.save),
  )!;
  await (done.props.onClick as () => Promise<void>)();
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("does not switch a draft API source to login after the Agent requests authentication", () => {
  props.conversation = undefined;
  props.sourceContext = "original-draft-api";
  props.progress = {
    step: 1,
    choice: "api",
    selection: {
      service: { id: "api", model: "chosen", revision: "rev" },
      config: { model: "chosen" },
    },
  };
  h.required = true;
  const result = render();
  expect(props.onProgress).not.toHaveBeenCalled();
  const account = result.find((node) => node.type === AgentAuthSection)!;
  expect(account.props.source).toBe("original-draft-api");
  expect(account.props.connection).toEqual(
    expect.objectContaining({ choice: "api", stage: "api" }),
  );
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
  expect(props.progress.choice).toBe("api");
  expect(props.progress.selection?.service?.id).toBe("api");
});

it("saves ordinary management only through Done, then closes after the saved confirmation", async () => {
  props.conversation = undefined;
  props.progress = {
    step: 2,
    choice: "existing",
    selection: {
      service: null,
      config: { model: "chosen", reasoning: "ultra" },
    },
  };
  props.onConfirmManagement = vi.fn(async () => true);
  expect(managementDone().props.disabled).toBe(true);
  confirmModelRead();
  const done = managementDone();
  expect(done.props.disabled).toBe(false);
  await (done.props.onClick as () => Promise<void>)();
  expect(props.onConfirmManagement).toHaveBeenCalledWith(
    card.id,
    props.progress.selection,
  );
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps management open after save failure and lets Done retry the same selection", async () => {
  props.conversation = undefined;
  props.progress = {
    step: 2,
    choice: "existing",
    selection: { service: null, config: { model: "chosen" } },
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce(
      new Error("Agent 准备进度尚未保存，请重试后再关闭。"),
    )
    .mockResolvedValue(true);
  props.onConfirmManagement = save;
  confirmModelRead();
  expect(managementDone().props.disabled).toBe(false);
  await (managementDone().props.onClick as () => Promise<void>)();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(render().some((node) => node.props.role === "alert")).toBe(true);
  await (managementDone().props.onClick as () => Promise<void>)();
  expect(save).toHaveBeenCalledTimes(2);
  expect(props.onClose).toHaveBeenCalledOnce();
});

it("does not confirm management through X or through an old conversation's readonly Done", async () => {
  props.onConfirmManagement = vi.fn(async () => true);
  await (managementDone().props.onClick as () => Promise<void>)();
  expect(props.onConfirmManagement).not.toHaveBeenCalled();
  props.conversation = undefined;
  const close = render().find(
    (node) => node.type === "button" && node.props.className === "icon-btn",
  )!;
  (close.props.onClick as () => void)();
  expect(props.onConfirmManagement).not.toHaveBeenCalled();
  expect(props.onClose).toHaveBeenCalledTimes(2);
});

it("does not close a later entry when its management confirmation is no longer current", async () => {
  props.conversation = undefined;
  props.progress = {
    step: 2,
    choice: "existing",
    selection: { service: null, config: { model: "chosen" } },
  };
  props.onConfirmManagement = vi.fn(async () => false);
  await (managementDone().props.onClick as () => Promise<void>)();
  expect(props.onClose).not.toHaveBeenCalled();
});
