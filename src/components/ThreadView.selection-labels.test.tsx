import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, () => {}],
  useMemo: (read: () => unknown) => read(),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
const h = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
// These tests invoke ThreadView with a minimal hook harness; browser permissions
// have their own controller/component tests and are absent from these scenarios.
vi.mock("../runtime/browser_sharing", async (original) => {
  const actual = await original<typeof import("../runtime/browser_sharing")>();
  const noop = async () => {};
  const empty: import("../runtime/browser_sharing").BrowserSharingModel = {
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    refresh: noop,
    allow: noop,
    stop: noop,
    respond: noop,
  };
  return { ...actual, useBrowserSharing: () => empty };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { WorkspacePopover } from "./WorkspacePopover";
import { ModelPicker } from "./ModelPicker";
import { SessionOptionsList } from "./SessionOptionsMenu";
import {
  threads,
  freshThreadState,
  type ThreadState,
} from "../runtime/sessions";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { STRINGS } from "../runtime/strings";
import type { ConfigCheck } from "../runtime/config_check";

type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function text(tree: ReactNode): string {
  let result = "";
  Children.forEach(tree, (child) => {
    if (typeof child === "string" || typeof child === "number") result += child;
    else if (isValidElement<Record<string, unknown>>(child))
      result += text(child.props.children as ReactNode);
  });
  return result;
}
function noActionRequests() {
  expect(
    h.invoke.mock.calls.some(([command]) =>
      [
        "session_set_config",
        "session_set_mode",
        "session_confirm_config",
        "session_prompt",
        "auth_run",
        "auth_manual_run",
        "settings_set",
      ].includes(String(command)),
    ),
  ).toBe(false);
}
function popup(thread: ThreadState) {
  const rendered = nodes(
    ThreadView({
      thread,
      active: true,
      agents: [],
      onGoSettings: vi.fn(),
      onOpened: vi.fn(),
      onNew: vi.fn(),
    }),
  );
  const composer = rendered.find((node) => node.type === Composer)!;
  return nodes(composer.props.controls as ReactNode).find(
    (node) => node.type === WorkspacePopover,
  )!;
}
function seed(status: ConfigCheck["status"] | null = "blocked") {
  const thread = freshThreadState(
    "label-history",
    "example",
    "/original",
    "old",
  );
  thread.identity = "established";
  thread.resumed = true;
  thread.service = {
    id: "original-service",
    model: "original-service-model",
    fingerprint: "keep-origin",
  };
  thread.configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "current-model",
      options: [{ value: "current-model", name: "Current Model" }],
    },
  ];
  if (status)
    thread.configCheck = {
      status,
      protectedIds: ["model", "old-effort"],
      issues:
        status === "ready"
          ? []
          : [
              {
                id: "model",
                category: "model",
                reason: "changed",
                expected: "original-model",
                current: "current-model",
              },
              {
                id: "old-effort",
                category: "thought_level",
                reason: "missing",
                expected: "ultra",
                current: null,
              },
            ],
      current: {
        choices: [
          {
            id: "model",
            category: "model",
            type: "select",
            value: "current-model",
          },
        ],
      },
    };
  if (status === "confirmation_required")
    thread.configCheck!.issues = [
      {
        id: "old-effort",
        category: "thought_level",
        reason: "unrecorded",
        expected: null,
        current: "medium",
      },
    ];
  if (status === "record_failed") thread.configCheck!.issues = [];
  thread.modelDrift = status !== "ready";
  return thread;
}
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockClear();
});

it("labels restored values as current returns and shows original differences without claiming the original choice was restored", () => {
  const thread = seed();
  const before = structuredClone(thread);
  const update = vi.spyOn(threads, "setConfig");
  const confirm = vi.spyOn(threads, "confirmConfig");
  const send = vi.spyOn(threads, "send");
  const content = popup(thread).props.children as ReactNode;
  expect(text(content)).toContain("Agent 当前返回的模型");
  expect(text(content)).toContain("Current Model");
  expect(text(content)).toContain("original-model");
  expect(text(content)).toContain("current-model");
  expect(text(content)).toContain("ultra");
  expect(text(content)).toContain(STRINGS.repair.unknownModel);
  expect(text(content)).not.toContain(W.settingsFixed);
  expect(nodes(content).some((node) => node.type === ModelPicker)).toBe(false);
  expect(thread).toEqual(before);
  expect(update).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  noActionRequests();
});

it.each([false, true])(
  "does not invent a default model or reuse an unverified record when the current model is missing (option present: %s)",
  (optionPresent) => {
    const thread = seed();
    if (optionPresent) thread.configOptions[0].currentValue = null;
    else thread.configOptions = [];
    thread.recordedModel = "unverified-original-canary";
    thread.configCheck!.issues = [
      {
        id: "model",
        category: "model",
        reason: "missing",
        expected: null,
        current: null,
      },
    ];
    const content = popup(thread).props.children as ReactNode;
    expect(text(content)).toContain("Agent 当前返回的模型");
    expect(text(content)).toContain(STRINGS.repair.unknownModel);
    expect(text(content)).not.toContain(STRINGS.switcher.defaultModel);
    expect(
      nodes(content)
        .filter((node) => node.type === "dd")
        .at(-1)?.props.children,
    ).toBe(STRINGS.repair.unknownModel);
    expect(text(content)).not.toContain("unverified-original-canary");
    expect(text(content)).not.toContain(W.settingsFixed);
  },
);

it.each(["confirmation_required", "record_failed"] as const)(
  "uses the actual %s outcome rather than a restored-choice claim",
  (status) => {
    const thread = seed(status);
    const content = popup(thread).props.children as ReactNode;
    expect(text(content)).toContain("Agent 当前返回的模型");
    expect(text(content)).not.toContain(W.settingsFixed);
    expect(text(content)).toContain(
      status === "record_failed"
        ? STRINGS.repair.configRecordFailed
        : STRINGS.repair.confirmConfigHint,
    );
    noActionRequests();
  },
);

it("keeps unknown-check history read-only without guessing what was originally selected", () => {
  const thread = seed(null);
  const content = popup(thread).props.children as ReactNode;
  expect(text(content)).toContain("Agent 当前返回的模型");
  expect(text(content)).not.toContain(W.settingsFixed);
  expect(text(content)).not.toContain("original-model");
  expect(nodes(content).some((node) => node.type === ModelPicker)).toBe(false);
});

it("keeps same-named changed choices distinguishable by their public IDs", () => {
  const thread = seed();
  thread.configOptions.push({
    ...thread.configOptions[0],
    id: "speed",
    name: "Model",
  });
  thread.configOptions[0].currentValue = "current-main";
  thread.configOptions[1].currentValue = "current-speed";
  thread.configCheck!.issues = [
    {
      id: "model",
      category: "model",
      reason: "changed",
      expected: "original-main",
      current: "current-main",
    },
    {
      id: "speed",
      category: "model",
      reason: "changed",
      expected: "original-speed",
      current: "current-speed",
    },
  ];
  const content = popup(thread).props.children as ReactNode;
  expect(text(content)).toContain(
    "Model（model）：original-main → current-main",
  );
  expect(text(content)).toContain(
    "Model（speed）：original-speed → current-speed",
  );
  expect(thread.configOptions.map((o) => o.id)).toEqual(["model", "speed"]);
});

it("keeps verified history and editable draft guidance distinct without changing their choices", () => {
  const ready = seed("ready");
  expect(text(popup(ready).props.children as ReactNode)).toContain(
    W.settingsFixed,
  );
  const draft = seed("ready");
  draft.identity = "draft";
  draft.resumed = false;
  const content = popup(draft).props.children as ReactNode;
  expect(text(content)).not.toContain(W.settingsFixed);
  expect(text(content)).toContain("发送前可以选择模型与推理选项。");
  expect(nodes(content).some((node) => node.type === ModelPicker)).toBe(true);
  expect(nodes(content).some((node) => node.type === SessionOptionsList)).toBe(
    true,
  );
  expect(draft.configOptions[0].currentValue).toBe("current-model");
  expect(draft.service).toEqual(ready.service);
  noActionRequests();
});
