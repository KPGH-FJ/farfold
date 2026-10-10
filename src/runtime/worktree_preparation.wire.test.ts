import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseWorktreeLocation } from "./worktree_types";
import {
  parsePreparationInspection,
  parsePreparationValidation,
} from "./worktree_preparation_types";

const path =
  "docs/evidence/2026-10-09-capability-hardening/worktree-preparation/backend/preparation-wire.json";
it("accepts the actual Rust temp-Git inspection and validation without rebuilding either DTO", () => {
  const bytes = readFileSync(path);
  const wire = JSON.parse(bytes.toString()) as {
    inspection: unknown;
    validation: unknown;
  };
  const raw = wire.inspection as {
    location: unknown;
    projectRelativePath: string;
  };
  const location = parseWorktreeLocation(raw.location);
  const inspection = parsePreparationInspection(
    wire.inspection,
    location,
    raw.projectRelativePath,
  );
  expect(inspection).toEqual(wire.inspection);
  expect(() =>
    parsePreparationValidation(wire.validation, inspection.inspectionId),
  ).not.toThrow();
  expect(inspection.git).toEqual({ kind: "main", otherWorktreeCount: 0 });
  expect(inspection.location.ownership).toBe("existing");
  expect(inspection.location.revision).toBe(0);
  expect(inspection.facts).toHaveLength(22);
  expect(inspection.facts.every((f) => f.nodeKind === "missing")).toBe(true);
  expect(inspection.coverage).toEqual({
    scope: "fixedNameMetadata",
    checkedNames: 22,
    complete: true,
  });
});
