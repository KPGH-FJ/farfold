import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  stateCursor: 0,
  refCursor: 0,
  memoCursor: 0,
  effectCursor: 0,
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  memos: [] as { value: unknown; deps: unknown[] }[],
  effects: [] as { deps: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = h.stateCursor++;
      if (index >= h.states.length) h.states[index] = initial;
      return [
        h.states[index],
        (next: unknown) => {
          h.states[index] =
            typeof next === "function" ? next(h.states[index]) : next;
        },
      ];
    },
    useRef: (initial: unknown) =>
      (h.refs[h.refCursor++] ??= { current: initial }),
    useMemo: (create: () => unknown, deps: unknown[]) => {
      const index = h.memoCursor++;
      if (
        !h.memos[index] ||
        deps.some((value, i) => !Object.is(value, h.memos[index].deps[i]))
      )
        h.memos[index] = { value: create(), deps };
      return h.memos[index].value;
    },
    useEffect: (create: () => (() => void) | void, deps: unknown[]) => {
      const index = h.effectCursor++,
        old = h.effects[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        const entry = { deps } as typeof old;
        h.effects[index] = entry;
        h.pending.push(() => {
          old?.cleanup?.();
          entry.cleanup = create() || undefined;
        });
      }
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
      getSnapshot(),
  };
});

import {
  BrowserRememberedPages,
  type BrowserRememberedPagesProps,
} from "./BrowserRememberedPages";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type {
  RememberedBrowserList,
  RememberedBrowserPagesClient,
} from "../runtime/browser_remembered";
import { REMEMBERED_BROWSER_STRINGS as S } from "../runtime/browser_remembered_strings";

type Element = ReactElement<Record<string, any>>;
function elements(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, any>>(child)) return;
    result.push(child, ...elements(child.props.children));
  });
  return result;
}
function render(props: BrowserRememberedPagesProps) {
  h.stateCursor = h.refCursor = h.memoCursor = h.effectCursor = 0;
  const outer = BrowserRememberedPages(props) as Element;
  const body =
    typeof outer.type === "function"
      ? (outer.type as (props: Record<string, any>) => ReactNode)(outer.props)
      : outer;
  const result = elements(body);
  for (const effect of h.pending.splice(0)) effect();
  return result;
}
const owner = { sessionId: "agent:/work:native", createdAt: 42 };
const page = {
  taskKey: owner.sessionId,
  label: "page-one",
  revision: 2,
  phase: "ready" as const,
  url: "https://www.rust-lang.org/learn?q=ownership#examples",
};
const list = (
  items: RememberedBrowserList["items"] = [],
  revision = 0,
): RememberedBrowserList => ({ owner, items, revision });
function fixture() {
  const client: RememberedBrowserPagesClient = {
    list: vi.fn(async () => list()),
    remember: vi.fn(async () => list([{ id: "one", url: page.url }], 1)),
    forget: vi.fn(async () => list([], 2)),
  };
  const props: BrowserRememberedPagesProps = {
    owner,
    page,
    active: true,
    client,
    onOpen: vi.fn(async () => true),
  };
  return { client, props };
}
async function loaded(props: BrowserRememberedPagesProps) {
  render(props);
  await Promise.resolve();
  return render(props);
}
function button(nodes: Element[], label: string) {
  return nodes
    .filter((node) => node.type === "button" && node.props.children === label)
    .at(-1)!;
}
beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.memos = [];
  h.effects = [];
  h.pending = [];
});
afterEach(() => {
  for (const effect of h.effects) effect.cleanup?.();
});

it("does not issue metadata requests or invent an owner for an unpersisted draft", () => {
  const { props, client } = fixture();
  const nodes = render({ ...props, owner: null });
  expect(nodes[0].props.children).toBe(S.draft);
  expect(client.list).not.toHaveBeenCalled();
  expect(client.remember).not.toHaveBeenCalled();
  expect(props.onOpen).not.toHaveBeenCalled();
});

it("requires the independent checkbox and preserves the complete confirmed URL", async () => {
  const { props, client } = fixture();
  button(await loaded(props), S.remember).props.onClick();
  let nodes = render(props);
  expect(nodes.find((node) => node.type === WorkspaceDialog)?.props.title).toBe(
    S.confirmTitle,
  );
  expect(
    nodes.some((node) => node.type === "p" && node.props.children === page.url),
  ).toBe(true);
  expect(button(nodes, S.remember).props.disabled).toBe(true);
  nodes
    .find((node) => node.type === "input")!
    .props.onChange({ target: { checked: true } });
  nodes = render(props);
  expect(button(nodes, S.remember).props.disabled).toBe(false);
  button(nodes, S.remember).props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  expect(client.remember).toHaveBeenCalledExactlyOnceWith({
    owner,
    expectedRevision: 0,
    label: page.label,
    pageRevision: page.revision,
    confirmedUrl: page.url,
  });
  expect(props.onOpen).not.toHaveBeenCalled();
});

it("cancelling confirmation performs no save", async () => {
  const { props, client } = fixture();
  button(await loaded(props), S.remember).props.onClick();
  button(render(props), S.cancel).props.onClick();
  expect(render(props).some((node) => node.type === WorkspaceDialog)).toBe(
    false,
  );
  expect(client.remember).not.toHaveBeenCalled();
});

it.each([
  { page: { ...page, label: "different-page" } },
  { page: { ...page, revision: 3 } },
  { page: { ...page, url: "https://www.rust-lang.org/changed" } },
  { active: false },
])(
  "withdraws a checked confirmation on navigation/selection/hide %#",
  async (patch) => {
    const { props, client } = fixture();
    button(await loaded(props), S.remember).props.onClick();
    let nodes = render(props);
    nodes
      .find((node) => node.type === "input")!
      .props.onChange({ target: { checked: true } });
    const staleConfirm = button(render(props), S.remember);
    render({ ...props, ...patch });
    staleConfirm.props.onClick();
    expect(client.remember).not.toHaveBeenCalled();
    expect(
      render({ ...props, ...patch }).some(
        (node) => node.type === WorkspaceDialog,
      ),
    ).toBe(false);
  },
);

it("opening the dormant list is inert until the exact item is clicked", async () => {
  const { props, client } = fixture();
  vi.mocked(client.list).mockResolvedValue(
    list([{ id: "one", url: page.url }], 6),
  );
  const nodes = await loaded(props);
  nodes
    .find(
      (node) =>
        node.type === "button" && String(node.props.children).includes(S.list),
    )!
    .props.onClick();
  let dialog = render(props);
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(
    dialog.some((node) => node.type === "a" || node.type === "iframe"),
  ).toBe(false);
  button(dialog, S.open).props.onClick();
  await Promise.resolve();
  expect(props.onOpen).toHaveBeenCalledExactlyOnceWith({
    owner,
    expectedRevision: 6,
    itemId: "one",
  });
  expect(client.remember).not.toHaveBeenCalled();
});

it("forget only changes the list and does not call the open action", async () => {
  const { props, client } = fixture();
  vi.mocked(client.list).mockResolvedValue(
    list([{ id: "one", url: page.url }], 1),
  );
  const nodes = await loaded(props);
  nodes
    .find(
      (node) =>
        node.type === "button" && String(node.props.children).includes(S.list),
    )!
    .props.onClick();
  button(render(props), S.forget).props.onClick();
  await Promise.resolve();
  expect(client.forget).toHaveBeenCalledExactlyOnceWith({
    owner,
    expectedRevision: 1,
    itemId: "one",
  });
  expect(props.onOpen).not.toHaveBeenCalled();
});
