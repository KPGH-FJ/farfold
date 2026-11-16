import { expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  cleanup: [] as (() => void)[],
  choose: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], (v: unknown) => (h.slots[i] = v)];
  },
  useRef: (initial: unknown) => {
    const i = h.cursor++;
    return h.slots[i] ?? (h.slots[i] = { current: initial });
  },
  useLayoutEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) h.cleanup.push(cleanup);
  },
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: h.choose }));
vi.mock("./HistoryPreviewBody", () => ({
  renderHistoryPreviewBody: () => null,
}));
import { KnownHistoryImport } from "./KnownHistoryImport";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";

function deferred() {
  let resolve!: (v?: any) => void;
  const promise = new Promise<any>((r) => (resolve = r));
  return { promise, resolve };
}
function nodes(node: ReactNode): any[] {
  const result: any[] = [];
  Children.forEach(node, (c) => {
    if (isValidElement<any>(c)) {
      result.push(c);
      result.push(
        ...nodes((c as ReactElement<{ children?: ReactNode }>).props.children),
      );
    }
  });
  return result;
}
it("keeps the read focus anchor while busy without allowing another action", async () => {
  h.cursor = 0;
  h.slots = ["owned-id", "/owned"];
  h.cleanup = [];
  const run = vi.fn(),
    read = vi.fn(),
    release = vi.fn();
  const tree = KnownHistoryImport({
    reader: {
      preview: null,
      state: { saved: null, error: null },
      retire: vi.fn(),
    } as any,
    busy: true,
    initialCwd: "/owned",
    current: () => true,
    run,
    read,
    release,
    add: vi.fn(),
  });
  const button = nodes(tree).find(
    (n) => n.type === "button" && n.props.children === S.knownRead,
  );
  expect(button.props.disabled).toBe(false);
  expect(button.props["aria-disabled"]).toBe(true);
  const preventDefault = vi.fn();
  button.props.onMouseDown({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  button.props.onClick();
  button.props.onClick();
  expect(run).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});
it.each(["read-after-release", "directory-after-modal"])(
  "rejects %s after child layout cleanup before parent passive cleanup",
  async (which) => {
    h.cursor = 0;
    h.slots = ["owned-id", "/owned"];
    h.cleanup = [];
    h.choose.mockReset();
    const wait = deferred(),
      retire = vi.fn(),
      read = vi.fn(async () => {}),
      release = vi.fn(async () => {}),
      jobs: Promise<void>[] = [];
    if (which === "read-after-release")
      release.mockReturnValueOnce(wait.promise);
    else h.choose.mockReturnValueOnce(wait.promise);
    const tree = KnownHistoryImport({
      reader: {
        preview: null,
        state: { saved: null, error: null },
        retire,
        reset: vi.fn(),
      } as any,
      busy: false,
      initialCwd: "/owned",
      current: () => true,
      run: async (action) => {
        const job = action();
        jobs.push(job);
        await job;
      },
      release,
      read,
      add: vi.fn(),
    });
    const label =
      which === "read-after-release" ? S.knownRead : S.chooseLocation;
    const button = nodes(tree).find(
      (n) => n.type === "button" && n.props.children === label,
    );
    expect(button).toBeDefined();
    button.props.onClick();
    for (const cleanup of h.cleanup) cleanup(); // Child commit cleanup; parent passive mounted flag is intentionally still true.
    expect(retire).toHaveBeenCalled();
    wait.resolve("/new-owned");
    await Promise.all(jobs);
    expect(read).not.toHaveBeenCalled();
    if (which === "directory-after-modal")
      expect(release).not.toHaveBeenCalled();
  },
);
