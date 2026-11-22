import { h, card, props, render } from "./AgentSetup.repair.test-support";
import { afterEach, expect, it, vi } from "vitest";
import { setupStorage } from "../runtime/setup_storage";
import { OFFICIAL_READONLY_CHECK_STRINGS as S } from "../runtime/official_readonly_check_strings";
import type { OfficialReadOnlyCheck } from "../runtime/preparation";
import { OfficialReadOnlyAttempt } from "./AgentOfficialReadOnlyCheck";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentPrerequisites } from "./AgentPrerequisites";

const descriptor: OfficialReadOnlyCheck = {
  id: "offline-check",
  modelOptionId: "current_model",
  reasoningOptionId: "current_reasoning",
};
const selection = {
  service: null,
  config: { current_model: "saved-model", current_reasoning: "high" },
};

function prepare(step: number) {
  props.card = step === 0 ? { ...card, status: "installed" } : card;
  props.conversation = undefined;
  props.intent = "use";
  props.progress = { step, choice: "existing", accessStage: "method" };
  h.preparationInfo = {
    dependencies: [],
    links: [],
    officialReadOnlyCheck: descriptor,
  };
  return vi
    .spyOn(setupStorage, "confirmedSelection")
    .mockReturnValue(selection);
}

const button = (label: string, nodes = render()) =>
  nodes.find((node) => node.type === "button" && node.props.children === label);

function click(label: string, nodes = render()) {
  const control = button(label, nodes);
  expect(control).toBeDefined();
  (control?.props.onClick as () => void)();
}

async function settled() {
  render();
  await Promise.resolve();
  await Promise.resolve();
  return render();
}

afterEach(() => vi.restoreAllMocks());

it.each([0, 1])(
  "opens the saved check from step %i without a preparation draft",
  async (step) => {
    prepare(step);
    const original = props.progress;
    click(S.savedTitle, await settled());

    const checking = render();
    const attempt = checking.find(
      (node) => node.type === OfficialReadOnlyAttempt,
    );
    expect(attempt?.props).toMatchObject({
      open: true,
      target: {
        agentId: card.id,
        cwd: "/old",
        checkId: descriptor.id,
        model: "saved-model",
        reasoningEffort: "high",
      },
    });
    expect(checking.some((node) => node.type === AgentAuthSection)).toBe(false);
    expect(checking.find((node) => node.type === "footer")?.props.hidden).toBe(
      true,
    );
    click(S.back, checking);
    expect(button(S.savedTitle)).toBeDefined();
    expect(props.progress).toBe(original);
    expect(props.onProgress).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  },
);

it("does not prepare ordinary model options when an account connection becomes ready during the check", async () => {
  prepare(1);
  props.progress.accessStage = "account";
  click(S.savedTitle, await settled());
  props.agents.statuses = {
    [card.id]: [
      {
        connectionId: "other",
        purpose: "preparation",
        agentId: card.id,
        cwd: "/old",
        state: "ready",
        agentName: null,
        agentVersion: null,
        authMethods: [],
      },
    ],
  } as typeof props.agents.statuses;
  const open = render();
  const prerequisites = open.find((node) => node.type === AgentPrerequisites);
  (prerequisites?.props.onChange as (ready: boolean) => void)(true);
  expect(render().some((node) => node.type === OfficialReadOnlyAttempt)).toBe(
    true,
  );
  expect(h.prepare).not.toHaveBeenCalled();
  expect(props.onProgress).not.toHaveBeenCalled();
});

it("requires a declared check and a complete confirmed model selection", async () => {
  const saved = prepare(0);
  saved.mockReturnValue({
    service: null,
    config: { current_model: "saved-model" },
  });
  expect(button(S.savedTitle, await settled())).toBeUndefined();
  saved.mockReturnValue(selection);
  expect(button(S.savedTitle)).toBeDefined();
  const before = props.card;
  props.card = { ...before, localVersion: "different-program" };
  h.preparationInfo = { dependencies: [], links: [] };
  expect(button(S.savedTitle, await settled())).toBeUndefined();
  expect(h.prepare).not.toHaveBeenCalled();
});
