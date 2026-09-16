import { describe, expect, it } from "vitest";
import { describeSessionOpening, sessionOpeningError } from "./session-opening";

const session = {
  farfoldSessionId: "host-opencode",
  runtimeProductId: "opencode",
  title: "Document review",
  workingCopyPath: "/projects/docs worktree",
};

describe("pending Session presentation", () => {
  it("names the failed target and explains a confirmed missing native locator", () => {
    const error = sessionOpeningError(
      { kind: "open", sessionId: session.farfoldSessionId, session },
      "opencode",
      "Farfold Session cannot be opened: native_locator_unavailable",
    );
    expect(error).toContain("Document review");
    expect(error).toContain("恢复原记录后重试");
    expect(error).toContain("native_locator_unavailable");
  });
  it("preserves other native errors without guessing a missing-history cause", () => {
    const error = sessionOpeningError(
      { kind: "create", projectPath: "/project" },
      "pi",
      new Error("Working Copy already occupied"),
    );
    expect(error).toContain("Working Copy already occupied");
    expect(error).not.toContain("找不到原生会话记录");
  });
  it("shows the requested Host title and Working Copy before activation, without claiming readiness", () => {
    expect(
      describeSessionOpening(
        { kind: "open", sessionId: session.farfoldSessionId, session },
        "opencode",
      ),
    ).toEqual({
      sessionId: "host-opencode",
      title: "Document review",
      projectPath: "/projects/docs worktree",
      action: "正在打开会话",
    });
  });
  it.each([
    null,
    { ...session, farfoldSessionId: "old-host" },
    { ...session, runtimeProductId: "pi" },
  ])(
    "does not borrow an absent, old or other Runtime binding: %j",
    (candidate) => {
      expect(
        describeSessionOpening(
          {
            kind: "open",
            sessionId: session.farfoldSessionId,
            session: candidate,
          },
          "opencode",
        ),
      ).toEqual({
        sessionId: null,
        title: "打开会话",
        projectPath: null,
        action: "正在核对会话",
      });
    },
  );
  it("uses the selected Working Copy when creating, with no invented persistent Session identity", () => {
    expect(
      describeSessionOpening(
        { kind: "create", projectPath: "/projects/new copy" },
        "pi",
      ),
    ).toEqual({
      sessionId: null,
      title: "新对话",
      projectPath: "/projects/new copy",
      action: "正在新建会话",
    });
  });
  it("supports Pi with its own matching binding and does not default unknown Runtimes to Pi", () => {
    const pi = { ...session, runtimeProductId: "pi" };
    const target = {
      kind: "open" as const,
      sessionId: pi.farfoldSessionId,
      session: pi,
    };
    expect(describeSessionOpening(target, "pi").projectPath).toBe(
      pi.workingCopyPath,
    );
    expect(describeSessionOpening(target, "unknown").projectPath).toBeNull();
  });
});
