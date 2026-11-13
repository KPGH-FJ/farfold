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
