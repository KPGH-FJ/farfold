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

import {
  resolveTaskProgress,
  selectTaskRequirements,
  renderTaskRequirements,
} from "./agent-task-reference.mjs";

const currentBlock = (id, body) =>
  `<!-- task-current: ${id} -->\n### ${id}\n\n${body}\n<!-- /task-current -->`;
const withProgress = (id, progress) => {
  const parsed = parseTaskReference(reference);
  parsed.tasks = new Map([[id, { ...parsed.tasks.get(id), progress }]]);
  return parsed;
};

describe("single current task conclusion", () => {
  it("reads changed current evidence from status without copying it into requirements", () => {
    const ref = withProgress("P39", "[最新结论](status.md#p39)");
    for (const result of [
      "键盘焦点已修；结果播报待验。",
      "结果播报已有新的正式证据。",
    ]) {
      // Only the status source changes; original requirement and pointer stay fixed.
      const resolved = resolveTaskProgress(ref, currentBlock("P39", result));
      const task = resolved.tasks.get("P39");
      expect(task.progress).toBe(result);
      expect(task.completion).toBe(ref.tasks.get("P39").completion);
      const output = renderTaskRequirements(
        selectTaskRequirements(resolved, ["P39"]),
      );
      expect(output).toContain(`最新结论：${result}`);
      expect(output).toContain("结论来源：docs/status.md#p39");
    }
    expect(ref.tasks.get("P39").progress).toBe("[最新结论](status.md#p39)");
  });

  it("fails instead of falling back to obsolete text when the pointer target is missing", () => {
    expect(() =>
      resolveTaskProgress(withProgress("P39", "[最新结论](status.md#p39)"), ""),
    ).toThrow("current task conclusion missing");
  });

  it("rejects duplicate conclusions and a second body in the reference", () => {
    const block = currentBlock("P39", "最新证据");
    expect(() =>
      resolveTaskProgress(
        withProgress("P39", "[最新结论](status.md#p39)"),
        `${block}\n${block}`,
      ),
    ).toThrow("duplicate current task");
    expect(() =>
      resolveTaskProgress(withProgress("P39", "旧待修结论"), block),
    ).toThrow("still duplicates reference progress");
  });

  it.each([
    currentBlock("P999", "内容"),
    currentBlock("P39", "内容").replace("### P39", "### P45"),
    currentBlock("P39", "内容").replace("<!-- /task-current -->", ""),
    currentBlock("P39", " "),
  ])("rejects malformed, unknown or empty current sources", (status) => {
    expect(() =>
      resolveTaskProgress(
        withProgress("P39", "[最新结论](status.md#p39)"),
        status,
      ),
    ).toThrow();
  });

  it("labels an unmigrated reference as reference progress and accepts CRLF current sources", () => {
    // Deliberately use a fixture without current-source links for this boundary.
    const ref = {
      ...parseTaskReference(reference),
      tasks: new Map([
        [
          "P39",
          {
            id: "P39",
            title: "清单",
            progress: "旧参考进度",
            completion: "原条件",
            package: "D",
          },
        ],
      ]),
    };
    const output = renderTaskRequirements(
      selectTaskRequirements(resolveTaskProgress(ref, ""), ["P39"]),
    );
    expect(output).toContain("参考进度（尚未归并）：旧参考进度");
    ref.tasks.get("P39").progress = "[最新结论](status.md#p39)";
    expect(
      resolveTaskProgress(
        ref,
        withCrLf(currentBlock("P39", "当前结论")),
      ).tasks.get("P39").progress,
    ).toBe("当前结论");
  });
});
