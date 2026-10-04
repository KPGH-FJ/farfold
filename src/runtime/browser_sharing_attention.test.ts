import { expect, it, vi } from "vitest";
import { BrowserSharingAttention } from "./browser_sharing_attention";

it("exposes only the current task request id and notifies on meaningful changes", () => {
  const source = new BrowserSharingAttention();
  const listener = vi.fn();
  const release = source.subscribe(listener);
  const owner = {};
  source.update(owner, "task-a", "request-a");
  source.update(owner, "task-a", "request-a");
  expect(source.pendingRequestId("task-a")).toBe("request-a");
  expect(source.pendingRequestId("task-b")).toBeNull();
  expect(listener.mock.calls).toEqual([["task-a"]]);
  source.release(owner, "task-a");
  expect(source.pendingRequestId("task-a")).toBeNull();
  expect(listener.mock.calls).toEqual([["task-a"], ["task-a"]]);
  release();
  source.update(owner, "task-a", "request-b");
  expect(listener).toHaveBeenCalledTimes(2);
});

it("does not let old cleanup clear a newer request even when request ids match", () => {
  const source = new BrowserSharingAttention();
  const oldOwner = {};
  const newOwner = {};
  source.update(oldOwner, "task-a", "request-a");
  source.update(newOwner, "task-a", "request-a");
  source.release(oldOwner, "task-a");
  source.update(oldOwner, "task-a", null);
  expect(source.pendingRequestId("task-a")).toBe("request-a");
  source.update(newOwner, "task-a", "request-b");
  expect(source.pendingRequestId("task-a")).toBe("request-b");
  source.release(newOwner, "task-a");
  expect(source.pendingRequestId("task-a")).toBeNull();
});
