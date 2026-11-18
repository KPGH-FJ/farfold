import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  layouts: [] as (() => void)[],
  invoke: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (hooks.slots[hooks.cursor++] ??= { value: initial });
    return [slot.value, (value: unknown) => (slot.value = value)];
  },
  useRef: (initial: unknown) =>
    (hooks.slots[hooks.cursor++] ??= { value: { current: initial } }).value,
  useLayoutEffect: (setup: () => () => void, deps: unknown[]) => {
    const slot = (hooks.slots[hooks.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, index) => value !== slot.deps?.[index])
    ) {
      hooks.layouts.push(() => {
        slot.cleanup?.();
        slot.cleanup = setup();
      });
      slot.deps = deps;
    }
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: hooks.invoke,
  Channel: class {},
}));

import { PermissionRules } from "./PermissionRules";
import { freshThreadState, threads } from "../runtime/sessions";
import type { ThreadState } from "../runtime/session_types";

type Node = ReactElement<Record<string, unknown>>;
function elements(value: ReactNode): Node[] {
  const out: Node[] = [];
  Children.forEach(value, (item) => {
    if (isValidElement<Record<string, unknown>>(item)) {
      out.push(item, ...elements(item.props.children as ReactNode));
    }
  });
  return out;
}

function draw(thread: ThreadState) {
  hooks.cursor = 0;
  const tree = PermissionRules({ thread, connectionId: thread.connectionId! });
  for (const layout of hooks.layouts.splice(0)) layout();
  return elements(tree);
}

function click(thread: ThreadState) {
  const button = draw(thread).find((element) => element.type === "button")!;
  (button.props.onClick as () => void)();
}

function fixture() {
  const thread = freshThreadState("origin", "fixture", "/work", "native");
  thread.identity = "established";
  thread.connectionId = "connection";
  thread.sessionOperations = {
    forkCurrentContext: false,
    permissionRulesRead: true,
  };
  vi.spyOn(threads, "thread").mockReturnValue(thread);
  return thread;
}

const reply = {
  connectionId: "connection",
  nativeSessionId: "native",
  cwd: "/work",
  rules: [{ tool: "example_tool", pattern: "sample", action: "allow" }],
};

beforeEach(() => {
  hooks.slots = [];
  hooks.layouts = [];
  hooks.invoke.mockReset();
});

afterEach(() => {
  for (const slot of hooks.slots) slot.cleanup?.();
  vi.restoreAllMocks();
});

it("reads only on an explicit click, keeps one read in flight, and displays only the current folder's report", async () => {
  const thread = fixture();
  hooks.invoke.mockResolvedValue(reply);
  draw(thread);
  expect(hooks.invoke).not.toHaveBeenCalled();
  click(thread);
  click(thread);
  expect(hooks.invoke).toHaveBeenCalledExactlyOnceWith(
    "session_permission_rules",
    {
      agentId: "fixture",
      cwd: "/work",
      sessionId: "native",
      connectionId: "connection",
    },
  );
  await Promise.resolve();
  const view = draw(thread);
  expect(
    view
      .filter((element) => element.type === "code")
      .map((element) => element.props.children),
  ).toEqual(["/work", "example_tool", "sample"]);
});

it("discards a late result when the conversation reconnects", async () => {
  const thread = fixture();
  let finish!: (value: typeof reply) => void;
  hooks.invoke.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  click(thread);
  thread.connectionId = "replacement";
  finish(reply);
  await Promise.resolve();
  expect(draw(thread).filter((element) => element.type === "li")).toHaveLength(
    0,
  );
});

it("rejects a reply for a different working folder", async () => {
  const thread = fixture();
  hooks.invoke.mockResolvedValue({ ...reply, cwd: "/other" });
  click(thread);
  await Promise.resolve();
  const view = draw(thread);
  expect(view.filter((element) => element.type === "li")).toHaveLength(0);
  expect(
    view.find((element) => element.props.role === "alert")?.props.children,
  ).toBe("未能核对当前工作文件夹的审批规则。");
});
