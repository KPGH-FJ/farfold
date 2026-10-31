import { expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { ThreadView } from "./ThreadView";
import { ToolStep } from "./thread-items";
import { ArtifactPane } from "./ArtifactPane";
import { applyUpdate, threads } from "../runtime/sessions";
import { artifactPaneCards } from "../runtime/artifact_view";
import {
  canInspectToolContent,
  reportedArtifactCount,
} from "../runtime/reported_artifacts";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";

type Element = ReactElement<Record<string, unknown>>;
function capture(render: () => ReactNode) {
  let tree: ReactNode;
  function Capture() {
    tree = render();
    return tree;
  }
  renderToStaticMarkup(<Capture />);
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return nodes;
}
let serial = 0;
function seed(status = "pending", lost = false, uncertain = false) {
  const id = "owned-p18-pending-entry-" + ++serial;
  const s = threads.markOpenFailed(id, "fixture", "/synthetic", id, "fixture");
  s.openError = null;
  s.running = true;
  s.connectionId = "current-owned-channel";
  s.activeToolCallIds = ["new-command"];
  s.connectionLost = lost;
  s.connectionOutcomeUnknown = uncertain;
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "old-command",
    kind: "execute",
    status: "completed",
    title: "Old command",
    rawOutput: "OLD_ALREADY_COMPLETE",
  });
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "new-command",
    kind: "execute",
    status,
    title: "Owned command awaiting output",
    rawInput: { command: "printf OWNED_INPUT_INTENT_ONLY" },
    content: [],
  });
  const item = s.items.find(
    (i) => i.kind === "tool" && i.call.toolCallId === "new-command",
  );
  if (item?.kind !== "tool") throw new Error("Fixture missing its actual tool");
  return { s, item };
}

const cases = [
  { name: "pending", status: "pending", lost: false, uncertain: false },
  {
    name: "unknown request with active tool",
    status: "in_progress",
    lost: false,
    uncertain: true,
  },
  {
    name: "unknown tool after connection loss",
    status: "in_progress",
    lost: true,
    uncertain: false,
  },
];
it.each(cases)(
  "$name: already renders a truthful empty command in its selected scope",
  ({ status, lost, uncertain }) => {
    const { s, item } = seed(status, lost, uncertain);
    expect(reportedArtifactCount(s, item.id)).toBe(0);
    expect(artifactPaneCards(s, item.id)).toEqual([
      expect.objectContaining({
        kind: "command",
        status: lost ? "unknown" : status,
        output: "",
      }),
    ]);
    threads.openArtifactPane(s.key, item.id);
    const html = renderToStaticMarkup(<ArtifactPane thread={s} active />);
    expect(html).toContain("Owned command awaiting output");
    expect(html).toContain(
      lost
        ? STRINGS.thread.toolResultUnknown
        : status === "pending"
          ? W.stepsPending
          : W.stepsRunning,
    );
    expect(html).not.toContain("OLD_ALREADY_COMPLETE");
    expect(html).not.toContain("OWNED_INPUT_INTENT_ONLY");
  },
);

it.each(cases)(
  "$name: offers an exact content entry before the first output arrives",
  ({ status, lost, uncertain }) => {
    const { s, item } = seed(status, lost, uncertain);
    const view = capture(() =>
      ThreadView({
        thread: s,
        active: true,
        agents: [],
        onGoSettings: () => {},
        onOpened: () => {},
      }),
    );
    const step = view.find(
      (node) => node.type === ToolStep && node.props.call === item.call,
    )!;
    expect(step).toBeDefined();
    const actualStep = capture(() =>
      (step.type as (props: Record<string, unknown>) => ReactNode)(step.props),
    );
    const entry = actualStep.find(
      (node) =>
        node.type === "button" && node.props.children === T.viewArtifacts,
    );
    expect(
      entry,
      "A known pending command should expose its own waiting output view without inventing output.",
    ).toBeDefined();
    expect(
      reportedArtifactCount(s, item.id),
      "Opening a waiting view must not manufacture a completed artifact.",
    ).toBe(0);
    const before = structuredClone(item.call);
    const ipcBefore = vi.mocked(invoke).mock.calls.length;
    (entry!.props.onClick as (event: unknown) => void)({
      currentTarget: {} as HTMLElement,
    });
    expect(s.artifactPaneTarget?.roundId).toBe(item.id);
    const html = renderToStaticMarkup(<ArtifactPane thread={s} active />);
    expect(html).toContain("Owned command awaiting output");
    expect(html).toContain(
      lost
        ? STRINGS.thread.toolResultUnknown
        : status === "pending"
          ? W.stepsPending
          : W.stepsRunning,
    );
    expect(html).not.toContain("OLD_ALREADY_COMPLETE");
    expect(html).not.toContain("OWNED_INPUT_INTENT_ONLY");
    expect(item.call).toEqual(before);
    expect(s.connectionLost).toBe(lost);
    expect(s.connectionOutcomeUnknown).toBe(uncertain);
    expect(vi.mocked(invoke).mock.calls.slice(ipcBefore)).toEqual([]);
  },
);

it.each([
  {
    name: "missing input",
    input: undefined,
    status: "pending",
    kind: "execute",
  },
  { name: "null input", input: null, status: "pending", kind: "execute" },
  {
    name: "plain input string",
    input: "printf OWNED_INPUT_INTENT_ONLY",
    status: "pending",
    kind: "execute",
  },
  {
    name: "array input",
    input: [{ command: "printf OWNED_INPUT_INTENT_ONLY" }],
    status: "pending",
    kind: "execute",
  },
  {
    name: "empty command",
    input: { command: "" },
    status: "pending",
    kind: "execute",
  },
  {
    name: "whitespace command",
    input: { command: " \n " },
    status: "in_progress",
    kind: "execute",
  },
  {
    name: "nonstring command",
    input: { command: 7 },
    status: "pending",
    kind: "execute",
  },
  {
    name: "location-only read",
    input: { command: "printf OWNED_INPUT_INTENT_ONLY" },
    status: "pending",
    kind: "read",
  },
  {
    name: "unknown tool kind",
    input: { command: "printf OWNED_INPUT_INTENT_ONLY" },
    status: "pending",
    kind: "future-tool-kind",
  },
  {
    name: "completed empty command",
    input: { command: "printf OWNED_INPUT_INTENT_ONLY" },
    status: "completed",
    kind: "execute",
  },
  {
    name: "failed empty command",
    input: { command: "printf OWNED_INPUT_INTENT_ONLY" },
    status: "failed",
    kind: "execute",
  },
])(
  "does not invent a waiting command entry for $name",
  ({ input, status, kind }) => {
    const { s, item } = seed();
    item.call.rawInput = input;
    item.call.status = status;
    item.call.kind = kind;
    const view = capture(() =>
      ThreadView({
        thread: s,
        active: true,
        agents: [],
        onGoSettings: () => {},
        onOpened: () => {},
      }),
    );
    const step = view.find(
      (node) => node.type === ToolStep && node.props.call === item.call,
    )!;
    const actualStep = capture(() =>
      (step.type as (props: Record<string, unknown>) => ReactNode)(step.props),
    );
    expect(
      actualStep.find(
        (node) =>
          node.type === "button" && node.props.children === T.viewArtifacts,
      ),
    ).toBeUndefined();
    expect(reportedArtifactCount(s, item.id)).toBe(0);
  },
);

it("promotes only actual late output into the artifact count without changing its command scope", () => {
  const { s, item } = seed();
  expect(reportedArtifactCount(s, item.id)).toBe(0);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: item.call.toolCallId,
    rawOutput: "ACTUAL_FIRST_OUTPUT",
  });
  expect(reportedArtifactCount(s, item.id)).toBe(1);
  expect(artifactPaneCards(s, item.id)).toEqual([
    expect.objectContaining({
      output: "ACTUAL_FIRST_OUTPUT",
      status: "pending",
    }),
  ]);
});

it.each([null, undefined])(
  "keeps an unavailable or ambiguous scope without navigation authority: %s",
  (count) => {
    const { item } = seed();
    expect(canInspectToolContent(item.call, count)).toBe(false);
  },
);
