import { describe, expect, it } from "vitest";
import type { AgentCardModel } from "../runtime/agents";
import { programSummary, type Installation } from "./ProgramManager";
const card: AgentCardModel = {
  id: "codex",
  name: "Codex",
  description: "",
  status: "installed",
  version: "1.12.0",
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "registry",
  installable: true,
  registerable: false,
  custom: false,
  handshake: null,
  programEnv: "CODEX_CLI_PATH",
  bundledProgram: true,
};
const component: Installation = {
  id: "component",
  source: "registry",
  path: "/component",
  version: "1.12.0",
  managedRoot: "/component",
  programOnly: false,
  selected: true,
  inUse: false,
  canUninstall: false,
};
describe("program version summary", () => {
  it("never presents the connection component version as the selected Agent version", () => {
    const summary = programSummary(card, {
      items: [component],
      loading: false,
      error: null,
    });
    expect(summary).toContain("随附的程序");
    expect(summary).not.toContain("1.12.0");
    expect(summary).not.toContain("0 份安装");
  });
  it("keeps an exact selected CLI version when several versions were discovered", () => {
    const selected: Installation = {
      ...component,
      id: "selected",
      path: "/old/codex",
      managedRoot: null,
      version: "0.143.0",
      programOnly: true,
    };
    const newer = {
      ...selected,
      id: "newer",
      path: "/new/codex",
      version: "0.150.0",
      selected: false,
    };
    expect(
      programSummary(
        { ...card, programPath: selected.path },
        { items: [component, newer, selected], loading: false, error: null },
      ),
    ).toBe("0.143.0 · 2 份安装");
  });
});
