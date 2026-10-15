import { afterEach, beforeEach, expect, it } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";

beforeEach(resetHarness);
afterEach(cleanupHarness);

it("passes the actual prepared editor owner without replacing the original new input", () => {
  const originalDraft = structuredClone(h.draft);
  const owner = () => true;
  call("EmptyState", "onPreparedKey", "prepared-A");
  call("EmptyState", "onPreparedComposerOwner", owner);
  expect(component("ThreadPage").preparedComposerIsCurrent).toBe(owner);
  expect(h.draft).toEqual(originalDraft);
  call("EmptyState", "onPreparedComposerOwner", null);
  expect(component("ThreadPage").preparedComposerIsCurrent).toBeNull();
});

it.each(["start", "library"])(
  "releases a retired prepared workspace on %s without changing navigation or draft choice",
  (route) => {
    const originalDraft = structuredClone(h.draft);
    const originalChoice = structuredClone(h.choice);
    call("EmptyState", "onPreparedKey", "prepared-A");
    expect(component("ThreadPage")).toMatchObject({
      viewKey: "prepared-A",
      active: true,
    });
    if (route === "library") call("Sidebar", "onLibrary", { kind: "all" });

    // This is the child's retirement callback, not a navigation request.
    call("EmptyState", "onPreparedKey", null);
    expect(
      render().some(
        (node) =>
          typeof node.type === "function" && node.type.name === "ThreadPage",
      ),
    ).toBe(false);
    expect(component("EmptyState").active).toBe(route === "start");
    expect(component("ConversationLibrary").active).toBe(route === "library");

    call("Sidebar", "onNew");
    expect(component("EmptyState").active).toBe(true);
    expect(
      render().some(
        (node) =>
          typeof node.type === "function" && node.type.name === "ThreadPage",
      ),
    ).toBe(false);
    expect(h.draft).toEqual(originalDraft);
    expect(h.choice).toEqual(originalChoice);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.clearDraft).not.toHaveBeenCalled();
  },
);
