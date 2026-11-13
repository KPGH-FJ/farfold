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
  deps: [] as unknown[][],
  layout: [] as (() => void)[],
  passive: [] as (() => void)[],
  cleanup: [] as { kind: string; run: () => void }[],
  writes: [] as number[],
  read: vi.fn(),
  save: vi.fn(),
  retry: vi.fn(),
  open: vi.fn(),
  archive: {
    ready: true,
    running: false,
    count: 2,
    error: null as string | null,
  },
}));
vi.mock("react", async (original) => {
  const schedule = (
    kind: "layout" | "passive",
    effect: () => void | (() => void),
    deps: unknown[],
  ) => {
    const index = h.cursor++;
    if (
      !h.deps[index] ||
      deps.some((item, i) => !Object.is(item, h.deps[index][i]))
    ) {
      h.deps[index] = deps;
      h[kind].push(() => {
        const run = effect();
        if (run) h.cleanup.push({ kind, run });
      });
    }
  };
  return {
    ...(await original<typeof import("react")>()),
    useState: (initial: unknown) => {
      const index = h.cursor++,
        slots = h.slots;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (value: unknown) => {
          h.writes.push(index);
          slots[index] =
            typeof value === "function" ? value(slots[index]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = h.cursor++;
      return h.slots[index] ?? (h.slots[index] = { current: initial });
    },
    useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) =>
      schedule("layout", effect, deps),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) =>
      schedule("passive", effect, deps),
  };
});
vi.mock("../runtime/sessions", () => ({
  threads: { readAutoArchiveDays: h.read, setAutoArchiveDays: h.save },
}));
vi.mock("../runtime/auto_archive", async (original) => ({
  ...(await original<typeof import("../runtime/auto_archive")>()),
  useAutoArchive: () => h.archive,
  retryAutoArchive: h.retry,
}));
import { AutoArchiveSettings } from "./AutoArchiveSettings";
import { ARCHIVE_SETTINGS as S } from "../runtime/archive_settings_strings";
import { ARCHIVE_STRINGS } from "../runtime/auto_archive";
import { STRINGS } from "../runtime/strings";

type El = ReactElement<Record<string, any>>;
function nodes(tree: ReactNode): El[] {
  const result: El[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, any>>(child)) {
      result.push(child, ...nodes(child.props.children));
    }
  });
  return result;
}
function view() {
  h.cursor = 0;
  return nodes(AutoArchiveSettings({ onOpenArchived: h.open }));
}
function commit() {
  for (const fn of h.layout.splice(0)) fn();
  for (const fn of h.passive.splice(0)) fn();
}
function retire(kind?: string) {
  const clean = h.cleanup.filter((c) => !kind || kind === c.kind);
  h.cleanup = h.cleanup.filter((c) => kind && kind !== c.kind);
  clean.forEach((c) => c.run());
}
async function tick() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
async function load() {
  view();
  commit();
  await tick();
  return view();
}
function select(value: string) {
  view()
    .find((n) => n.type === "select")!
    .props.onChange({ target: { value } });
}
function input(value: string) {
  view()
    .find((n) => n.type === "input")!
    .props.onChange({ target: { value } });
}
function submit() {
  view()
    .find((n) => n.type === "form")!
    .props.onSubmit({ preventDefault: vi.fn() });
}
function button(label: string) {
  return view().find((n) => n.type === "button" && n.props.children === label)!;
}
function deferred() {
  let resolve!: (value?: any) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function resetMount() {
  h.slots = [];
  h.deps = [];
  h.layout = [];
  h.passive = [];
  h.cleanup = [];
  h.writes = [];
}
beforeEach(() => {
  resetMount();
  h.read.mockReset().mockResolvedValue(30);
  h.save.mockReset().mockResolvedValue(undefined);
  h.retry.mockReset();
  h.open.mockReset();
  h.archive = { ready: true, running: false, count: 2, error: null };
});

it("only applies custom days after explicit save and keeps the current rule visible while editing", async () => {
  await load();
  select("custom");
  input("1");
  expect(h.save).not.toHaveBeenCalled();
  expect(view().some((n) => n.props.children === S.current(30))).toBe(true);
  submit();
  await tick();
  expect(h.save).toHaveBeenCalledExactlyOnceWith(1);
  expect(view().some((n) => n.props.children === S.current(1))).toBe(true);
  expect(h.retry).not.toHaveBeenCalled();
});
it.each([
  "",
  " ",
  "0",
  "-1",
  "+1",
  "1.5",
  "1e2",
  "Infinity",
  "NaN",
  "366",
  "9007199254740993",
  "1天",
])("does not save invalid custom input %j", async (value) => {
  await load();
  select("custom");
  input(value);
  submit();
  await tick();
  expect(h.save).not.toHaveBeenCalled();
  expect(
    view().some(
      (n) =>
        n.props.role === "alert" &&
        nodes(n.props.children).length === 0 &&
        n.props.children[0] === S.invalid,
    ),
  ).toBe(true);
  expect(view().find((n) => n.type === "input")!.props.value).toBe(value);
});
it.each(["1", "365"])("saves the legal %s day boundary", async (value) => {
  await load();
  select("custom");
  input(value);
  submit();
  await tick();
  expect(h.save).toHaveBeenCalledExactlyOnceWith(Number(value));
});
it("displays a previously saved value outside the new editor range without rewriting it", async () => {
  h.read.mockResolvedValue(500);
  await load();
  expect(view().find((n) => n.type === "select")!.props.value).toBe(500);
  expect(view().some((n) => n.type === "option" && n.props.value === 500)).toBe(
    true,
  );
  expect(h.save).not.toHaveBeenCalled();
  select("custom");
  submit();
  await tick();
  expect(h.save).not.toHaveBeenCalled();
  expect(view().some((n) => n.props.children === S.current(500))).toBe(true);
});
it("keeps input and old policy after a failed save, then explicitly retries", async () => {
  h.save.mockRejectedValueOnce(new Error("private diagnostic"));
  await load();
  select("custom");
  input("2");
  submit();
  await tick();
  expect(view().find((n) => n.type === "input")!.props.value).toBe("2");
  expect(view().some((n) => n.props.children === S.current(30))).toBe(true);
  expect(
    view().some((n) => String(n.props.children).includes("private diagnostic")),
  ).toBe(false);
  submit();
  await tick();
  expect(h.save.mock.calls).toEqual([[2], [2]]);
  expect(view().some((n) => n.props.children === S.current(2))).toBe(true);
});
it("synchronously rejects repeated submission and editing while the original save is pending", async () => {
  const pending = deferred();
  h.save.mockReturnValue(pending.promise);
  await load();
  select("custom");
  input("1");
  const oldInput = view().find((n) => n.type === "input")!,
    oldSelect = view().find((n) => n.type === "select")!;
  submit();
  submit();
  oldInput.props.onChange({ target: { value: "5" } });
  oldSelect.props.onChange({ target: { value: "7" } });
  expect(h.save).toHaveBeenCalledExactlyOnceWith(1);
  expect(view().find((n) => n.type === "input")!.props.value).toBe("1");
  expect(button(S.save).props["aria-disabled"]).toBe(true);
  expect(button(S.save).props.disabled).toBeUndefined();
  pending.resolve();
  await tick();
  expect(view().some((n) => n.props.children === S.current(1))).toBe(true);
});
it("does not invent a default after read failure and only retries the settings read once", async () => {
  h.read.mockRejectedValueOnce(new Error("read failed"));
  await load();
  expect(view().find((n) => n.type === "select")!.props.disabled).toBe(true);
  expect(h.save).not.toHaveBeenCalled();
  const retry = button(STRINGS.common.retry);
  retry.props.onClick();
  retry.props.onClick();
  view();
  commit();
  await tick();
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(view().find((n) => n.type === "select")!.props.value).toBe(30);
});
it.each([0, 7, 30, 90])(
  "retains preset %s and the existing archive actions",
  async (value) => {
    await load();
    select(String(value));
    await tick();
    expect(h.save).toHaveBeenCalledExactlyOnceWith(value);
    expect(button(ARCHIVE_STRINGS.retry).props.disabled).toBe(value === 0);
    button(ARCHIVE_STRINGS.view).props.onClick();
    expect(h.open).toHaveBeenCalledOnce();
    expect(
      view().some((n) => n.props.children === ARCHIVE_STRINGS.protected),
    ).toBe(true);
    expect(
      view().some((n) => n.props.children === ARCHIVE_STRINGS.restored),
    ).toBe(true);
  },
);
it("retires pending reads during layout cleanup before passive cleanup", async () => {
  const pending = deferred();
  h.read.mockReturnValue(pending.promise);
  view();
  commit();
  retire("layout");
  h.writes = [];
  pending.resolve(90);
  await tick();
  expect(h.writes).toEqual([]);
});
it.each(["resolve", "reject"] as const)(
  "keeps a late %s from an unmounted save away from a new editor",
  async (outcome) => {
    const pending = deferred();
    h.save.mockReturnValue(pending.promise);
    await load();
    select("custom");
    input("1");
    submit();
    retire("layout");
    retire("passive");
    resetMount();
    h.read.mockResolvedValue(90);
    await load();
    select("custom");
    input("25");
    h.writes = [];
    if (outcome === "resolve") pending.resolve();
    else pending.reject("failed");
    await tick();
    expect(h.writes).toEqual([]);
    expect(view().find((n) => n.type === "input")!.props.value).toBe("25");
    expect(view().some((n) => n.props.children === S.current(90))).toBe(true);
  },
);
it("uses a fresh owner for StrictMode effect setup and rejects the previous read", async () => {
  const pending = deferred();
  h.read.mockReturnValueOnce(pending.promise).mockResolvedValue(7);
  view();
  commit();
  retire();
  h.deps = [];
  view();
  commit();
  await tick();
  pending.resolve(90);
  await tick();
  expect(view().find((n) => n.type === "select")!.props.value).toBe(7);
  select("custom");
  input("2");
  submit();
  await tick();
  expect(h.save).toHaveBeenCalledExactlyOnceWith(2);
});
