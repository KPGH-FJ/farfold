import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CodexPanel } from "./CodexPanel";
import { OpenCodePanel } from "./OpenCodePanel";
import { PiPanel } from "./PiPanel";
import { RUNTIME_PANELS, runtimePanelEntry } from "./runtime-panel-registry";
import { Workspace } from "./Workspace";

it("registers every Runtime product exactly once in the shared shell", () => {
  expect(RUNTIME_PANELS.map((entry) => entry.product).sort()).toEqual([
    "codex",
    "opencode",
    "pi",
  ]);
  for (const entry of RUNTIME_PANELS) {
    expect(runtimePanelEntry(entry.product)).toBe(entry);
  }
});

it("routes every Runtime product to its live ACP panel", () => {
  expect(runtimePanelEntry("opencode")?.Panel).toBe(OpenCodePanel);
  expect(runtimePanelEntry("pi")?.Panel).toBe(PiPanel);
  expect(runtimePanelEntry("codex")?.Panel).toBe(CodexPanel);
});

it("keeps every Runtime panel mounted in the shared shell", () => {
  const source = readFileSync(
    new URL("./Workspace.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toContain("RUNTIME_PANELS.map");
  expect(source).not.toContain("ownShellPanels");
  expect(source).not.toContain("shell-inactive");
});

it("routes a Session request only to the panel owning that Runtime", () => {
  const source = readFileSync(
    new URL("./Workspace.tsx", import.meta.url),
    "utf8",
  );
  // Other mounted panels must not see (and thus consume or display) a request
  // whose Session belongs to a different Runtime product.
  expect(source).toContain("requestedHostSession?.runtimeProductId === entry.product");
  expect(source).toContain("ownsRequest ? requestedHostSessionId : null");
  // Clearing is scoped to the handled Session so a newer request survives.
  expect(source).toContain("current === sessionId ? null : current");
});

it("renders the Pi panel empty state on the default shell", () => {
  const html = renderToStaticMarkup(<Workspace />);
  expect(html).toContain("开始一段新对话");
  expect(html).toContain("Pi ACP 未连接");
  expect(html.match(/class="app-shell/g)).toHaveLength(1);
});
