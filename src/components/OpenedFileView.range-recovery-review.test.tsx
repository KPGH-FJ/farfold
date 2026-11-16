import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkbookCapture, WorkbookPreview } from "../runtime/xlsx_types";
const h = vi.hoisted(() => ({
  owner: "parent",
  cursor: 0,
  slots: new Map<
    string,
    { value?: unknown; deps?: unknown[]; cleanup?: () => void }[]
  >(),
  effects: [] as (() => void)[],
  inspect: vi.fn(),
  open: vi.fn(),
  prepare: vi.fn(),
  monitor: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: { inspectLink: h.inspect, open: h.open },
}));
vi.mock("../runtime/office_preview_prepare", () => ({
  prepareOfficePreview: h.prepare,
}));
vi.mock("./useFileRevisionMonitor", () => ({
  useFileRevisionMonitor: h.monitor,
}));
vi.mock("./WorkbookFilePreview", () => ({ WorkbookFilePreview: () => null }));
vi.mock("./FileCopyJobsStatus", () => ({ FileCopyJobsStatus: () => null }));
vi.mock("react", async (original) => {
  const api = await original<typeof import("react")>();
  function slot() {
    let all = h.slots.get(h.owner);
    if (!all) h.slots.set(h.owner, (all = []));
    const index = h.cursor++;
    return { all, index, old: all[index] };
  }
  function effect(setup: () => void | (() => void), deps: unknown[]) {
    const { all, index, old } = slot();
    if (!old || deps.some((d, i) => !Object.is(d, old.deps?.[i]))) {
      all[index] = { deps, cleanup: old?.cleanup };
      h.effects.push(() => {
        old?.cleanup?.();
        all[index].cleanup = setup() || undefined;
      });
    }
  }
  return {
    ...api,
    useState: (initial: unknown) => {
      const { all, index, old } = slot();
      const state =
        old ??
        (all[index] = {
          value: typeof initial === "function" ? initial() : initial,
        });
      return [
        state.value,
        (next: unknown) => {
          state.value = typeof next === "function" ? next(state.value) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const { all, index, old } = slot();
      return (old ?? (all[index] = { value: { current: initial } })).value;
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useSyncExternalStore: (_s: unknown, read: () => unknown) => read(),
  };
});
import { OpenedFileView } from "./OpenedFileView";
import { WorkbookFilePreview } from "./WorkbookFilePreview";
import { WorkbookRangeSelection } from "./WorkbookRangeSelection";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { WORKBOOK_STRINGS as B } from "../runtime/workbook_strings";
const file = {
  root: "/work",
  path: "/work/review.xlsx",
  resolvedPath: "/work/review.xlsx",
  name: "review.xlsx",
  size: 10,
  version: "v1",
  sha256: "a".repeat(64),
};
const capture: WorkbookCapture = {
  file,
  parts: [],
  entries: [],
  inflatedBytes: 0,
};
const preview: WorkbookPreview = {
  date1904: false,
  styles: [],
  warnings: [],
  sheets: [{ id: "sheet-real", name: "actual", state: "visible" }],
  sheet: { id: "sheet-real", cells: [], rows: [], columns: [], merges: [] },
};
type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (n) => {
    if (isValidElement<Record<string, unknown>>(n))
      result.push(n, ...elements(n.props.children as ReactNode));
  });
  return result;
}
function draw(owner: string, make: () => ReactNode) {
  h.owner = owner;
  h.cursor = 0;
  const tree = make();
  for (const effect of h.effects.splice(0)) effect();
  return elements(tree);
}
const props = {
  threadKey: "range-recovery-review",
  path: "review.xlsx",
  workingDirectory: "/work",
  active: true,
  onOpenHtml: vi.fn(),
};
const parent = () => draw("parent", () => OpenedFileView(props));
const child = () =>
  parent().find((n) => n.type === WorkbookFilePreview)!
    .props as unknown as Parameters<typeof WorkbookFilePreview>[0];
const retireSelection = { current: null as (() => void) | null };
const leaf = () => {
  const p = child();
  return draw("range", () =>
    WorkbookRangeSelection({
      file: p.file,
      capture,
      preview,
      hiddenSheetSelected: false,
      interactionBlocked: Boolean(p.interactionBlocked),
      window: { firstRow: 1, lastRow: 100, firstColumn: 1, lastColumn: 24 },
      isCurrent: () => !child().interactionBlocked,
      retireSelection,
      onRange: vi.fn(),
      onClose: vi.fn(),
      onOfficeTargetAvailability: p.onOfficeTargetAvailability,
      onOfficeTargetConfirm: p.onOfficeTargetConfirm!,
      onOfficeTargetEditing: p.onOfficeTargetEditing,
    }),
  );
};
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
beforeEach(() => {
  h.slots.clear();
  h.effects = [];
  h.inspect.mockReset().mockResolvedValue(file);
  h.open.mockReset();
  h.prepare.mockReset();
  h.monitor.mockReset();
});
afterEach(() => {
  for (const all of h.slots.values()) for (const slot of all) slot.cleanup?.();
});

async function invalidRange() {
  parent();
  await drain();
  const p = child();
  p.onStatus?.({ file: p.file, state: "ready" });
  parent();
  let tree = leaf();
  (
    tree.find(
      (n) =>
        n.type === "input" && n.props["aria-label"] === B.feedbackRangeInput,
    )!.props.onChange as (e: unknown) => void
  )({ target: { value: "A1:" } });
  tree = leaf();
  expect(tree.find((n) => n.type === "input")!.props.value).toBe("A1:");
}
function monitor() {
  return h.monitor.mock.calls.at(-1)![0] as {
    apply: (next: typeof file, valid: () => boolean) => Promise<string>;
  };
}
function click(label: string) {
  const node = parent().find(
    (n) => n.type === "button" && n.props.children === label,
  )!;
  expect(node).toBeDefined();
  (node.props.onClick as () => void)();
}
it("actual invalid range form defers automatic replacement without a live target", async () => {
  await invalidRange();
  expect(await monitor().apply({ ...file, version: "v2" }, () => true)).toBe(
    "deferred",
  );
  expect(h.prepare).not.toHaveBeenCalled();
});
it("external action blocking keeps invalid input and its editing hold after it completes", async () => {
  await invalidRange();
  const rangeRevision = child().rangeRevision;
  let finish!: () => void;
  h.open.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  click(S.open);
  leaf();
  expect(child().interactionBlocked).toBe(true);
  expect(child().rangeRevision).toBe(rangeRevision);
  finish();
  await drain();
  const tree = leaf();
  expect(child().interactionBlocked).toBe(false);
  expect(tree.find((n) => n.type === "input")!.props.value).toBe("A1:");
  expect(await monitor().apply({ ...file, version: "v2" }, () => true)).toBe(
    "deferred",
  );
  expect(h.prepare).not.toHaveBeenCalled();
});
it("Office explicit reread retires invalid editing while keeping the verified workbook", async () => {
  await invalidRange();
  const rangeRevision = child().rangeRevision ?? 0;
  let finish!: (value: typeof file) => void;
  h.inspect.mockImplementationOnce(
    () =>
      new Promise<typeof file>((resolve) => {
        finish = resolve;
      }),
  );
  h.prepare.mockResolvedValueOnce({
    kind: "workbook",
    file,
    capture,
    value: preview,
  });
  click(S.refresh);
  expect(child()).toMatchObject({
    file,
    interactionBlocked: true,
    rangeRevision: rangeRevision + 1,
  });
  // Mirror WorkbookGrid's editor unmount for a changed revision.
  for (const slot of h.slots.get("range") ?? []) slot.cleanup?.();
  h.slots.delete("range");
  finish(file);
  await drain();
  const p = child();
  expect(p.rangeRevision).toBe(rangeRevision + 1);
  p.onStatus?.({ file: p.file, state: "ready" });
  parent();
  h.prepare.mockResolvedValue({
    kind: "workbook",
    file: { ...file, version: "v2" },
    capture,
    value: preview,
  });
  expect(await monitor().apply({ ...file, version: "v2" }, () => true)).toBe(
    "applied",
  );
  expect(h.prepare).toHaveBeenCalledTimes(2);
});
