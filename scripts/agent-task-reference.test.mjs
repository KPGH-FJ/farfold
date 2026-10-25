import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTaskReference } from "./agent-task-reference.mjs";

const reference = readFileSync(
  fileURLToPath(
    new URL("../docs/agent-access-requirements.md", import.meta.url),
  ),
  "utf8",
).replace(/\r\n/g, "\n");
const withCrLf = (text) => text.replace(/\n/g, "\r\n");

describe("task requirement text line endings", () => {
  it.each([
    ["CRLF checkout", withCrLf(reference)],
    ["mixed checkout", withCrLf(reference).replace(/\r\n/, "\n")],
  ])("preserves all requirements and scope for %s", (_label, text) => {
    const expected = parseTaskReference(reference);
    expect(expected.tasks.size).toBe(151);
    expect(expected.packages.size).toBe(16);
    expect(parseTaskReference(text)).toEqual(expected);
  });

  it.each([
    ["LF", reference],
    ["CRLF", withCrLf(reference)],
  ])("still rejects missing official scope with %s", (_label, text) => {
    expect(() =>
      parseTaskReference(
        text.replace("## 官方接口与范围约束", "## 无官方范围说明"),
      ),
    ).toThrow("official interface and scope constraints missing");
  });
});
