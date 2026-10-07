import { afterEach, beforeEach, expect, it } from "vitest";
import {
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";

beforeEach(resetHarness);
afterEach(cleanupHarness);

it("routes native menu actions through the shared app commands", async () => {
  await Promise.resolve();
  const menu = h.menuHandlers.get("app-menu");
  expect(menu).toBeDefined();
  const missing = (name: string) =>
    !render().some(
      (item) => typeof item.type === "function" && item.type.name === name,
    );
  menu!({ payload: { action: "new" } });
  expect(component("EmptyState").active).toBe(true);
  menu!({ payload: { action: "settings" } });
  expect(component("SettingsPage").active).toBe(true);
  expect(component("EmptyState").active).toBe(false);
  menu!({ payload: { action: "search" } });
  expect(missing("CommandPalette")).toBe(false);
  menu!({ payload: { action: "search" } });
  expect(missing("CommandPalette")).toBe(true);
  menu!({ payload: { action: "checkUpdates" } });
  expect(component("SettingsPage").tab).toBe("general");
  expect(component("SettingsPage").generalRequest).toMatchObject({
    kind: "update",
  });
  const first = component("SettingsPage").generalRequest;
  menu!({ payload: { action: "shortcuts" } });
  expect(component("SettingsPage").generalRequest).toMatchObject({
    kind: "shortcuts",
  });
  expect(component("SettingsPage").generalRequest).not.toBe(first);
  menu!({ payload: { action: "privacy" } });
  expect(component("SettingsPage").generalRequest).toMatchObject({
    kind: "privacy",
  });
  menu!({ payload: { action: "toggleSidebar" } });
  expect(missing("Sidebar")).toBe(true);
  menu!({ payload: { action: "toggleSidebar" } });
  expect(missing("Sidebar")).toBe(false);
  const last = component("SettingsPage").generalRequest;
  menu!({ payload: { action: "unrelated" } });
  expect(component("SettingsPage").generalRequest).toBe(last);
});
