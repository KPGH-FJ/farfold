import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { browserSurfaceGuard } from "./runtime/browser_surface";
import { threads } from "./runtime/sessions";

beforeEach(resetHarness);
afterEach(cleanupHarness);

function expectNoWork() {
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
  expect(h.clearDraft).not.toHaveBeenCalled();
  expect(h.preserveDraft).not.toHaveBeenCalled();
  expect(h.draft.text).toBe("OWN-ORIGINAL-DRAFT");
}
it("a test reminder click selects only reminder settings, preserving the originating draft", async () => {
  const refresh = vi.mocked(threads.refreshIndex);
  refresh.mockClear();
  await h.notificationSettings!();
  expect(component("SettingsPage")).toMatchObject({
    active: true,
    tab: "general",
    generalRequest: { kind: "notifications" },
  });
  expect(refresh).not.toHaveBeenCalled();
  expectNoWork();
  call("SettingsPage", "onReturn");
  expect(component("EmptyState").active).toBe(true);
  expectNoWork();
});
it("waits for the native page guard before focusing reminder settings", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((r) => (resolve = r));
  const hide = vi.fn(() => pending);
  const owned = browserSurfaceGuard.register(hide);
  try {
    await h.notificationSettings!();
    expect(hide).toHaveBeenCalledOnce();
    expect(component("EmptyState").active).toBe(true);
    expect(
      render().some(
        (x) =>
          x.type instanceof Function &&
          x.type.name === "SettingsPage" &&
          x.props.active,
      ),
    ).toBe(false);
    expectNoWork();
    resolve();
    await vi.waitFor(() =>
      expect(browserSurfaceGuard.getSnapshot().busy).toBe(false),
    );
    expect(component("SettingsPage")).toMatchObject({
      active: true,
      tab: "general",
      generalRequest: { kind: "notifications" },
    });
    expectNoWork();
  } finally {
    resolve();
    owned.release();
    await pending;
  }
});
it("does not use a late test activation callback after App disposal", async () => {
  const old = h.notificationSettings!;
  cleanupHarness();
  const before = h.slots.slice();
  await old();
  expect(h.slots).toEqual(before);
  expectNoWork();
});
