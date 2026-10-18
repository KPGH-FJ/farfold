import { afterEach, beforeEach, expect, it } from "vitest";
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { useMessageMediaVisibility } from "./components/message-media-visibility";

type Element = ReactElement<Record<string, unknown>>;
type Observation = {
  key: string;
  routeHidden: boolean;
  active: boolean;
  mediaVisible: boolean;
};
let observations: Observation[] = [];

// This only replaces the expensive ThreadPage leaf. Its production App JSX
// ancestors, including the route and all real context boundaries, are retained.
// App hooks use the existing controlled navigation harness; React SSR and the
// media context are real. This is route composition evidence, not App DOM E2E.
function MediaContextProbe({
  page,
  routeHidden,
}: {
  page: Element;
  routeHidden: boolean;
}) {
  const mediaVisible = useMessageMediaVisibility();
  const observation = {
    key: page.props.viewKey as string,
    routeHidden,
    active: page.props.active as boolean,
    mediaVisible,
  };
  observations.push(observation);
  return (
    <span
      data-page={observation.key}
      data-route-hidden={String(routeHidden)}
      data-active={String(observation.active)}
      data-media-visible={String(mediaVisible)}
    />
  );
}

function retainActualPageAncestors(
  node: ReactNode,
  routeHidden = false,
): ReactNode[] {
  return Children.toArray(node).flatMap((child): ReactNode[] => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    const hidden =
      child.type === "div" && child.props.className === "workspace-route"
        ? child.props.hidden === true
        : routeHidden;
    if (typeof child.type === "function" && child.type.name === "ThreadPage")
      return [
        <MediaContextProbe
          key={child.props.viewKey as string}
          page={child}
          routeHidden={hidden}
        />,
      ];
    const children = retainActualPageAncestors(
      child.props.children as ReactNode,
      hidden,
    );
    return children.length ? [cloneElement(child, undefined, children)] : [];
  });
}

function capture() {
  // render()[0] is the real root returned by App(), not a copied route fixture.
  // Pruning unrelated leaves preserves every actual ancestor of ThreadPage.
  const tree = render()[0];
  observations = [];
  renderToStaticMarkup(retainActualPageAncestors(tree));
  const result = observations.map((observation) => ({ ...observation }));
  return result;
}

function page(key: string) {
  const node = render().find(
    (candidate) =>
      typeof candidate.type === "function" &&
      candidate.type.name === "ThreadPage" &&
      candidate.props.viewKey === key,
  );
  expect(node, `missing production ThreadPage ${key}`).toBeDefined();
  return node!.props;
}

function open(key: "old-A" | "test-B") {
  call("ConversationLibrary", "onOpen", {
    id: key,
    agentId: key === "old-A" ? "A" : "B",
    cwd: `/${key}`,
    nativeSessionId: key,
  });
}

function retain(key: string) {
  (page(key).onBrowserOwnersChange as (key: string, owns: boolean) => void)(
    key,
    true,
  );
}

function prepareTwoOwnedPages() {
  open("old-A");
  retain("old-A");
  open("test-B");
  retain("test-B");
}

beforeEach(resetHarness);
afterEach(cleanupHarness);
it("keeps both real retained route slots in order and retires only the hidden page's media context in either direction", () => {
  const originalDraft = h.draft;
  const originalChoice = structuredClone(h.choice);
  prepareTwoOwnedPages();
  for (const selected of ["test-B", "old-A", "test-B"] as const) {
    open(selected);
    const result = capture();
    expect(result.map(({ key }) => key)).toEqual(["old-A", "test-B"]);
    for (const observation of result) {
      const selectedPage = observation.key === selected;
      expect.soft(observation).toEqual({
        key: observation.key,
        routeHidden: !selectedPage,
        active: selectedPage,
        mediaVisible: selectedPage,
      });
    }
  }
  expect(h.draft).toBe(originalDraft);
  expect(h.choice).toEqual(originalChoice);
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
});

it.each(["library", "settings", "agents", "start"] as const)(
  "hides media for both retained routes while %s is visible",
  (destination) => {
    prepareTwoOwnedPages();
    if (destination === "library")
      call("Sidebar", "onLibrary", { kind: "all" });
    if (destination === "settings") call("Sidebar", "onSettings");
    if (destination === "agents") call("Sidebar", "onExplore");
    if (destination === "start") call("Sidebar", "onNew");
    const result = capture();
    expect(result.map(({ key }) => key)).toEqual(["old-A", "test-B"]);
    for (const observation of result)
      expect.soft(observation).toEqual({
        key: observation.key,
        routeHidden: true,
        active: false,
        mediaVisible: false,
      });
  },
);

it.each(["palette", "import"] as const)(
  "keeps the visible page's media context when the %s overlay disables its interactions",
  (overlay) => {
    open("old-A");
    expect(capture()).toEqual([
      { key: "old-A", routeHidden: false, active: true, mediaVisible: true },
    ]);
    if (overlay === "palette") call("Sidebar", "onSearch", null);
    else call("ConversationLibrary", "onImport", null);
    expect(capture()).toEqual([
      { key: "old-A", routeHidden: false, active: false, mediaVisible: true },
    ]);
    call(
      overlay === "palette" ? "CommandPalette" : "ImportConversations",
      "onClose",
    );
    expect(capture()).toEqual([
      { key: "old-A", routeHidden: false, active: true, mediaVisible: true },
    ]);
  },
);

it("keeps a prepared draft route while hiding its media on library navigation and restoring visibility on return", () => {
  const originalDraft = h.draft;
  call("EmptyState", "onPreparedKey", "prepared-A");
  expect(capture()).toEqual([
    { key: "prepared-A", routeHidden: false, active: true, mediaVisible: true },
  ]);
  call("Sidebar", "onLibrary", { kind: "all" });
  expect.soft(capture()).toEqual([
    {
      key: "prepared-A",
      routeHidden: true,
      active: false,
      mediaVisible: false,
    },
  ]);
  call("Sidebar", "onNew");
  expect(capture()).toEqual([
    { key: "prepared-A", routeHidden: false, active: true, mediaVisible: true },
  ]);
  expect(h.draft).toBe(originalDraft);
  expect(h.clearDraft).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.index).toEqual([]);
  expect(component("ThreadPage").draftComposerRef).toBeTypeOf("function");
});
