import { describe, expect, it } from "vitest";
import { parsePiCommands } from "./commands";

describe("parsePiCommands", () => {
  it("keeps the legacy RPC location field", () => {
    expect(
      parsePiCommands([
        { name: "fix-tests", source: "prompt", location: "project" },
      ]),
    ).toEqual([{ name: "fix-tests", source: "prompt", location: "project" }]);
  });

  it("maps Pi 0.84 sourceInfo scope to a project location", () => {
    expect(
      parsePiCommands([
        {
          name: "skill:gate0-marker",
          source: "skill",
          sourceInfo: { scope: "project" },
        },
      ]),
    ).toEqual([
      { name: "skill:gate0-marker", source: "skill", location: "project" },
    ]);
  });
});
