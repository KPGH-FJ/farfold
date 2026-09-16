import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_DETAIL_CHARS,
  activityStatus,
  toolDetailText,
} from "./PiActivity";

describe("activityStatus", () => {
  it("keeps the current Pi tool visible while details stay collapsed", () => {
    expect(
      activityStatus([
        {
          kind: "tool",
          id: "read",
          name: "read_file",
          summary: "",
          state: "completed",
        },
        {
          kind: "tool",
          id: "bash",
          name: "bash",
          summary: "pnpm test",
          state: "running",
        },
      ]),
    ).toBe("正在运行命令");
  });

  it("reports completion without inventing an outcome", () => {
    expect(
      activityStatus([
        {
          kind: "tool",
          id: "write",
          name: "write_file",
          summary: "",
          state: "completed",
        },
      ]),
    ).toBe("已结束");
  });

  it("keeps a failed Pi step visible while details stay collapsed", () => {
    expect(
      activityStatus([
        {
          kind: "tool",
          id: "bash",
          name: "bash",
          summary: "exit 1",
          state: "failed",
        },
      ]),
    ).toBe("有步骤失败");
  });

  it("surfaces Pi compaction and retry notices in the compact heading", () => {
    expect(activityStatus([], "Pi 正在压缩上下文。")).toBe(
      "Pi 正在压缩上下文。",
    );
  });

  it("bounds expanded terminal and tool output in the shared workbench", () => {
    const output = "x".repeat(MAX_TOOL_DETAIL_CHARS + 10);
    const detail = toolDetailText(output);

    expect(detail.length).toBeLessThan(output.length + 90);
    expect(detail).toContain(`前 ${MAX_TOOL_DETAIL_CHARS} 个字符`);
    expect(detail).not.toContain("x".repeat(MAX_TOOL_DETAIL_CHARS + 1));
  });
});
