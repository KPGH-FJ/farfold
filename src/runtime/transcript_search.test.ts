import { expect, it, vi } from "vitest";
import {
  SearchExpansion,
  registerSearchExpansion,
  revealSearchAncestors,
  keepSearchAncestors,
  openTranscriptAncestors,
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
