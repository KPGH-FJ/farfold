import { expect, it, vi } from "vitest";
import {
  SearchExpansion,
  registerSearchExpansion,
  revealSearchAncestors,
  keepSearchAncestors,
  openTranscriptAncestors,
  hasOpenSearchAncestors,
  searchDetailsCommitted,
} from "./transcript_search";

it("temporarily reveals a closed disclosure and restores its user's choice", () => {
  const changed = vi.fn(),
    fold = new SearchExpansion(false, changed);
  const release = fold.reveal();
  expect(fold.open).toBe(true);
  expect(fold.userOpen).toBe(false);
  release();
  expect(fold.open).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("explicit source navigation opens only its transcript and survives a search release", () => {
  const outside = { parentElement: null } as unknown as HTMLElement;
  const root = { parentElement: outside } as HTMLElement;
  const parent = { parentElement: root } as HTMLElement;
  const child = { parentElement: parent } as HTMLElement;
  root.contains = (node: Node | null) =>
    node === root || node === parent || node === child;
  const outsideFold = new SearchExpansion(),
    parentFold = new SearchExpansion(),
    childFold = new SearchExpansion();
  const cleanup = [
    registerSearchExpansion(outside, outsideFold),
    registerSearchExpansion(parent, parentFold),
    registerSearchExpansion(child, childFold),
  ];
  const release = revealSearchAncestors(child, root);
  openTranscriptAncestors(child, root);
  release();
  expect(parentFold.userOpen && childFold.userOpen).toBe(true);
  expect(outsideFold.open).toBe(false);
  childFold.choose(false);
  openTranscriptAncestors(outside, root);
  expect(childFold.open).toBe(false);
  cleanup.forEach((remove) => remove());
});
it("does not close a disclosure the user had opened", () => {
  const fold = new SearchExpansion(true);
  fold.reveal()();
  expect(fold.open).toBe(true);
});
it("a stale release cannot close the next search's reveal", () => {
  const fold = new SearchExpansion();
  const old = fold.reveal(),
    current = fold.reveal();
  old();
  expect(fold.open).toBe(true);
  current();
  expect(fold.open).toBe(false);
});
it("manual choices supersede a temporary reveal without being undone on close", () => {
  const fold = new SearchExpansion();
  const release = fold.reveal();
  fold.choose(false);
  expect(fold.open).toBe(false);
  fold.choose(true);
  release();
  expect(fold.open).toBe(true);
});

it("keeps a nested user-opened result mounted after releasing temporary ancestors", () => {
  const root = { parentElement: null } as unknown as HTMLElement;
  const parent = { parentElement: root } as HTMLElement;
  const child = { parentElement: parent } as HTMLElement;
  root.contains = (node: Node | null) =>
    node === root || node === parent || node === child;
  const ancestor = new SearchExpansion(),
    inner = new SearchExpansion();
  const cleanup = [
    registerSearchExpansion(parent, ancestor),
    registerSearchExpansion(child, inner),
  ];
  const release = revealSearchAncestors(child, root);
  inner.choose(true);
  keepSearchAncestors(child);
  release();
  expect(ancestor.userOpen).toBe(true);
  expect(inner.userOpen).toBe(true);
  expect(ancestor.open && inner.open).toBe(true);
  cleanup.forEach((remove) => remove());
});

type SearchNode = {
  tagName: string;
  hidden: boolean;
  open: boolean;
  parentElement: SearchNode | null;
  children: SearchNode[];
  contains: (node: unknown) => boolean;
};
function searchNode(tagName: string, parentElement: SearchNode | null = null) {
  const node: SearchNode = {
    tagName,
    hidden: false,
    open: false,
    parentElement,
    children: [],
    contains: (target) =>
      target === node || node.children.some((child) => child.contains(target)),
  };
  parentElement?.children.push(node);
  return node;
}
const pathOpen = (element: SearchNode, root: SearchNode) =>
  hasOpenSearchAncestors(
    element as unknown as HTMLElement,
    root as unknown as HTMLElement,
  );

it("allows only the first direct summary of a closed details to stay navigable", () => {
  const root = searchNode("DIV");
  const details = searchNode("DETAILS", root);
  const summary = searchNode("SUMMARY", details);
  const title = searchNode("SPAN", summary);
  const secondTitle = searchNode("SPAN", searchNode("SUMMARY", details));
  const body = searchNode("SPAN", searchNode("DIV", details));
  expect(pathOpen(summary, root)).toBe(true);
  expect(pathOpen(title, root)).toBe(true);
  expect(pathOpen(secondTitle, root)).toBe(false);
  expect(pathOpen(body, root)).toBe(false);
  details.open = true;
  expect(pathOpen(body, root)).toBe(true);
});

it("checks every nested closed details instead of accepting an inner summary alone", () => {
  const root = searchNode("DIV");
  const outer = searchNode("DETAILS", root);
  searchNode("SUMMARY", outer);
  const inner = searchNode("DETAILS", searchNode("DIV", outer));
  const title = searchNode("SPAN", searchNode("SUMMARY", inner));
  const body = searchNode("PRE", inner);
  expect(pathOpen(title, root)).toBe(false);
  outer.open = true;
  expect(pathOpen(title, root)).toBe(true);
  expect(pathOpen(body, root)).toBe(false);
  inner.open = true;
  expect(pathOpen(body, root)).toBe(true);
});

it("rejects a hidden ancestor or transcript even when the child has layout", () => {
  const root = searchNode("DIV");
  const detail = searchNode("DIV", root);
  const title = searchNode("SPAN", detail);
  detail.hidden = true;
  expect(pathOpen(title, root)).toBe(false);
  detail.hidden = false;
  root.hidden = true;
  expect(pathOpen(title, root)).toBe(false);
  root.hidden = false;
  expect(pathOpen(title, root)).toBe(true);
});

it("requires the actual owner path and stops checking after reaching that transcript", () => {
  const outside = searchNode("DETAILS");
  outside.hidden = true;
  const root = searchNode("DIV", outside);
  const title = searchNode("SPAN", root);
  expect(pathOpen(title, root)).toBe(true);
  expect(pathOpen(outside, root)).toBe(false);
  const detached = searchNode("SPAN");
  root.contains = () => true; // Model an ownership check made before detachment.
  expect(pathOpen(detached, root)).toBe(false);
});

function detailScope(...elements: HTMLDetailsElement[]) {
  return { querySelectorAll: () => elements } as unknown as HTMLElement;
}

it("waits for a released sibling's requested close to reach the DOM", () => {
  const sibling = { open: true } as HTMLDetailsElement;
  const model = new SearchExpansion();
  const release = model.reveal();
  const unregister = registerSearchExpansion(sibling, model);
  const root = detailScope(sibling);
  expect(searchDetailsCommitted(root)).toBe(true);
  release();
  expect(searchDetailsCommitted(root)).toBe(false);
  sibling.open = false;
  expect(searchDetailsCommitted(root)).toBe(true);
  unregister();
});

it("waits for requested opening and retains the user's committed preference", () => {
  const element = { open: false } as HTMLDetailsElement;
  const model = new SearchExpansion();
  const unregister = registerSearchExpansion(element, model);
  const root = detailScope(element);
  const release = model.reveal();
  expect(searchDetailsCommitted(root)).toBe(false);
  element.open = true;
  model.choose(true);
  release();
  expect(searchDetailsCommitted(root)).toBe(true);
  expect(model.userOpen).toBe(true);
  unregister();
});

it("does not wait on native details or another transcript's pending disclosure", () => {
  const native = { open: true } as HTMLDetailsElement;
  const outside = { open: false } as HTMLDetailsElement;
  const model = new SearchExpansion(true);
  const unregister = registerSearchExpansion(outside, model);
  expect(searchDetailsCommitted(detailScope(native))).toBe(true);
  expect(searchDetailsCommitted(detailScope(outside))).toBe(false);
  unregister();
});

it("stops tracking a disclosure when its actual registration is removed", () => {
  const element = { open: true } as HTMLDetailsElement;
  const unregister = registerSearchExpansion(element, new SearchExpansion());
  const root = detailScope(element);
  expect(searchDetailsCommitted(root)).toBe(false);
  unregister();
  expect(searchDetailsCommitted(root)).toBe(true);
});
