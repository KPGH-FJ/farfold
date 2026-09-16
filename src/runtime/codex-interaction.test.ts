import { describe, expect, it } from "vitest";
import { codexInteractions, decisionLabel } from "./codex-interaction";
import type { HostPendingInteraction } from "./host-shadow";
const pending: HostPendingInteraction = {
  runtime: {
    productId: "codex",
    installationId: "selected",
    adapterId: "codex-app-server",
  },
  runtimeGeneration: 3,
  interactionId: "key",
  nativeSessionId: "thread",
  kind: "codex_native",
  state: "pending",
  codex: {
    key: "key",
    threadId: "thread",
    turnId: "turn",
    itemId: "patch",
    method: "item/fileChange/requestApproval",
    decisions: ["accept", "decline"],
    questions: [],
    nativeRequest: {
      id: 1,
      method: "item/fileChange/requestApproval",
      params: {},
    },
  },
};
describe("Codex native interactions", () => {
  it("does not show another generation, installation or session's request", () => {
    expect(codexInteractions([pending], "selected", 3, "thread")).toEqual([
      pending,
    ]);
    expect(codexInteractions([pending], "selected", 2, "thread")).toEqual([]);
    expect(codexInteractions([pending], "another", 3, "thread")).toEqual([]);
    expect(codexInteractions([pending], "selected", 3, "other")).toEqual([]);
    expect(
      codexInteractions(
        [{ ...pending, kind: "open_code_permission" }],
        "selected",
        3,
        "thread",
      ),
    ).toEqual([]);
  });
  it("distinguishes command caching from same-file session approval and persistent rules", () => {
    expect(decisionLabel("acceptForSession", true)).toContain("相同文件");
    expect(decisionLabel("acceptForSession", false)).toContain("同类审批");
    expect(
      decisionLabel(
        {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["git", "status"],
          },
        },
        false,
      ),
    ).toContain("保存此命令规则");
    expect(decisionLabel("cancel", false)).toContain("中断");
  });
});
