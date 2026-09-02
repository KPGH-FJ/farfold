import { describe, expect, it } from "vitest";
import { cleanManualSessionTitle, cleanSessionTitle } from "./session-title";

describe("cleanSessionTitle", () => {
  it("removes injected Skill blocks and local paths", () => {
    expect(
      cleanSessionTitle(
        '<skill name="gate0-marker">ignore this</skill>\n请修改 /tmp/project/check.txt 并验证',
      ),
    ).toBe("请修改 并验证");
  });

  it("does not turn code blocks into a conversation title", () => {
    expect(cleanSessionTitle("```xml\n<skill>private</skill>\n```")).toBe(
      "新对话",
    );
  });

  it("removes local file URLs and Markdown destinations from automatic titles", () => {
    expect(
      cleanSessionTitle(
        "请检查 [配置](file:///Users/tw/private.json) 和 (file:///tmp/output.md)",
      ),
    ).toBe("请检查 配置 和");
  });

  it("keeps a compact real task", () => {
    expect(cleanSessionTitle("请读取 AGENTS.md，然后修复登录问题", 12)).toBe(
      "请读取 AGENTS.m…",
    );
  });

  it("preserves a user's explicit name except whitespace and length", () => {
    expect(cleanManualSessionTitle("  修复 /docs 登录问题（第一轮）  ")).toBe(
      "修复 /docs 登录问题（第一轮）",
    );
  });
});
