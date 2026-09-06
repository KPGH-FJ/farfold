import { describe, expect, it } from "vitest";
import { explainHostError } from "./host-error";

describe("Host action errors", () => {
  it("explains the installed-app Working Copy rejection without exposing internal IDs", () => {
    expect(
      explainHostError(
        "Host rejected Turn admission: blockers=working_copy_occupied; conflicting_turn_ids=turn-8c2a072e1551c93e8a3debe09c0b8009",
      ),
    ).toBe(
      "这个工作目录已有任务正在运行。请先停止或等待该任务完成后重试，或选择独立的工作副本。",
    );
  });
  it("handles the correlated Pi Error wrapper and every reported blocker", () => {
    const text = explainHostError(
      "Error: Host rejected Turn admission: blockers=session_busy,application_limit_reached; conflicting_turn_ids=turn-a,turn-b",
    );
    expect(text).toContain("当前对话已有任务");
    expect(text).toContain("同时运行的任务已达到上限");
    expect(
      explainHostError(
        "Host rejected Turn admission: blockers=host_maintenance; conflicting_turn_ids=",
      ),
    ).toContain("维护");
  });
  it("preserves unknown blockers, cleanup failures, and Provider errors verbatim", () => {
    for (const text of [
      "Host rejected Turn admission: blockers=new_blocker; conflicting_turn_ids=turn-a",
      "Host rejected Turn admission: blockers=working_copy_occupied; conflicting_turn_ids=turn-a; cleanup failed",
      "HTTP 403: model access denied",
    ])
      expect(explainHostError(text)).toBe(text);
  });
});
