import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MigratingRuntimePanel } from "./MigratingRuntimePanel";
import { OpenCodePanel } from "./OpenCodePanel";
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

it("routes OpenCode to its live panel and Pi/Codex to the migration placeholder", () => {
  expect(runtimePanelEntry("opencode")?.Panel).toBe(OpenCodePanel);
  expect(runtimePanelEntry("pi")?.Panel).toBe(MigratingRuntimePanel);
  expect(runtimePanelEntry("codex")?.Panel).toBe(MigratingRuntimePanel);
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

it("renders the Pi migration placeholder on the default shell", () => {
  const html = renderToStaticMarkup(<Workspace />);
  expect(html).toContain("Pi 工作台正在迁移");
  expect(html).toContain("新建、打开与发送暂不可用");
  expect(html.match(/class="app-shell/g)).toHaveLength(1);
});
