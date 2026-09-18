import { describe, expect, it } from "vitest";
import { decisionLabel } from "./codex-interaction";

describe("codex decision labels", () => {
  it("labels native decisions truthfully without inventing options", () => {
    expect(decisionLabel("accept", false)).toBe("允许本次");
    expect(decisionLabel("acceptForSession", true)).toContain("后续修改");
    expect(decisionLabel("decline", false)).toBe("拒绝，继续任务");
    expect(decisionLabel("cancel", false)).toBe("拒绝并中断任务");
    expect(decisionLabel("unknown-future-choice", false)).toBe(
      "未支持的原生选项",
    );
    expect(decisionLabel({ acceptWithExecpolicyAmendment: {} }, false)).toBe(
      "允许并保存此命令规则",
    );
    expect(decisionLabel({ applyNetworkPolicyAmendment: {} }, false)).toBe(
      "保存此网络规则",
    );
    expect(decisionLabel(42, false)).toBe("未支持的原生选项");
  });
});
