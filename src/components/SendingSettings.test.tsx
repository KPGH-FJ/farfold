import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  deps: [] as unknown[][],
  rows: [] as
    { id: string; title: string; cwd: string; archived?: boolean }[] | null,
  error: false,
  invoke: vi.fn(),
  save: vi.fn(),
  retry: vi.fn(),
  close: vi.fn(),
  location: undefined as boolean | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../runtime/drafts", () => ({
  newConversationChoice: { cwd: "/work" },
}));
vi.mock("../runtime/conversation_impacts", () => ({
  useStoredConversationIndex: () => ({
    rows: h.rows,
    error: h.error,
    retry: h.retry,
  }),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({
    ready: true,
    saving: false,
    error: null,
    locationEnabled: h.location,
    legacyPaused: false,
    setLocation: h.save,
    retry: h.retry,
  }),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots))
      h.slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[i],
      (v: unknown) =>
        (h.slots[i] = typeof v === "function" ? v(h.slots[i]) : v),
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = { current: initial };
    return h.slots[i];
  },
  useEffect: (fn: () => void, deps: unknown[]) => {
    const i = h.cursor++;
    if (!h.deps[i] || deps.some((v, j) => v !== h.deps[i][j])) {
      h.deps[i] = deps;
      h.effects.push(fn);
    }
  },
}));
import { SendingSettings } from "./SendingSettings";
import { SENDING_STRINGS as P } from "../runtime/sending_strings";
type El = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): El[] {
  const out: El[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child)) {
      out.push(child);
      out.push(...nodes(child.props.children as ReactNode));
    }
  });
  return out;
}
function view() {
  h.cursor = 0;
  return nodes(
    SendingSettings({ agents: [], defaultCwd: "/ordinary", onClose: h.close }),
  );
}
const click = async (element: El) =>
  (element.props.onClick as () => Promise<void> | void)();
const button = (all: El[], label: string) =>
  all.find((n) => n.type === "button" && n.props.children === label)!;
function row(path: string) {
  const element = view().find(
    (n) => typeof n.type === "function" && n.props.cwd === path,
  )!;
  return nodes(
    (element.type as (p: Record<string, unknown>) => ReactNode)(element.props),
  );
}
async function load() {
  view();
  h.effects.splice(0).forEach((fn) => fn());
  await Promise.resolve();
  return view();
}
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.deps = [];
  h.error = false;
  h.location = undefined;
  h.rows = [
    { id: "a", title: "Archived work", cwd: "/work", archived: true },
    { id: "b", title: "Other folder", cwd: "/other" },
  ];
  h.invoke.mockReset().mockResolvedValue({
    projects: { "/saved": { old: false } },
    locations: { "/location": false },
  });
  h.save.mockReset().mockResolvedValue(true);
  h.retry.mockReset();
  h.close.mockReset();
});
it("lists saved locations and confirms the affected draft and archived conversation before pausing", async () => {
  const all = await load();
  expect(
    all.filter((n) => typeof n.type === "function").map((n) => n.props.cwd),
  ).toEqual(["/ordinary", "/work", "/saved", "/location", "/other"]);
  await click(button(row("/work"), "暂停发送"));
  expect(h.save).not.toHaveBeenCalled();
  const confirm = view();
  expect(confirm.filter((n) => n.type === "footer")).toHaveLength(1);
  expect(
    confirm
      .filter((n) => n.type === "footer")
      .flatMap((n) => nodes(n.props.children as ReactNode))
      .filter((n) => n.type === "button"),
  ).toHaveLength(2);
  expect(confirm.some((n) => n.props.children === "Archived work")).toBe(true);
  expect(confirm.some((n) => n.props.children === P.currentDraft)).toBe(true);
  expect(confirm.some((n) => n.props.children === "Other folder")).toBe(false);
  expect(confirm.some((n) => n.props.children === P.future)).toBe(true);
  await click(button(confirm, "暂停发送"));
  expect(h.save).toHaveBeenCalledExactlyOnceWith(false);
  expect(view().some((n) => n.props.children === P.paused("/work"))).toBe(true);
});
it("back and failed saves preserve the policy and confirmation can be retried", async () => {
  await load();
  await click(button(row("/work"), "暂停发送"));
  await click(button(view(), P.back));
  expect(view().filter((n) => n.type === "footer")).toHaveLength(1);
  expect(h.close).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
  await click(button(row("/work"), "暂停发送"));
  h.save.mockResolvedValue(false);
  await click(button(view(), "暂停发送"));
  expect(button(view(), P.back)).toBeDefined();
  h.save.mockResolvedValue(true);
  await click(button(view(), "暂停发送"));
  expect(view().some((n) => n.props.children === P.paused("/work"))).toBe(true);
});
it("restores a paused location with an explicit no-auto-send result", async () => {
  await load();
  h.location = false;
  await click(button(row("/work"), "恢复发送"));
  expect(h.save).toHaveBeenCalledExactlyOnceWith(true);
  expect(view().some((n) => n.props.children === P.resumed("/work"))).toBe(
    true,
  );
});
it("never treats a missing or failed index as an empty safe impact list", async () => {
  h.rows = null;
  await load();
  expect(view().some((n) => n.props.children === P.loading)).toBe(true);
  expect(view().some((n) => typeof n.type === "function")).toBe(false);
  h.error = true;
  expect(view().some((n) => n.props.children === P.readFailed)).toBe(true);
  expect(h.save).not.toHaveBeenCalled();
});
