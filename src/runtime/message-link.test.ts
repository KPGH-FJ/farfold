import { describe, expect, it, vi } from "vitest";
import { messageLink } from "./message-link";
import { openProjectFile, revealProjectFile } from "./project-file-reference";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("native result link destinations", () => {
  it("preserves file paths and source-line references without a webview origin", () => {
    for (const [href, path] of [
      [
        "/Users/qa/Project%20Files/report.md:1",
        "/Users/qa/Project Files/report.md:1",
      ],
      ["./报告.md#L12-L15", "./报告.md"],
      ["file:///Users/qa/report.md#L2", "/Users/qa/report.md"],
      ["file://localhost/Users/qa/a%2520.md", "/Users/qa/a%20.md"],
      ["report.md:2", "report.md:2"],
    ])
      expect(messageLink(href)).toEqual({ kind: "file", path });
  });
  it("keeps web links and refuses executable protocols or malformed destinations", () => {
    expect(messageLink("https://example.com/a?q=b")).toEqual({
      kind: "web",
      url: "https://example.com/a?q=b",
    });
    for (const href of [
      undefined,
      "",
      "javascript:alert(1)",
      "data:text/html,x",
      "tauri://localhost/x",
      "file://remote/report.md",
      "//remote/x",
      "/x%00.md",
      "/x%zz.md",
      "#anchor",
      "https://",
    ]) {
      expect(messageLink(href)).toEqual({ kind: "unavailable" });
    }
  });
  it("sends the captured Host and native identities and propagates Host rejection", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("文件不在当前 Working Copy 内");
    await expect(
      revealProjectFile(
        { farfoldSessionId: "host-a", nativeSessionId: "native-a" },
        "../outside.md",
      ),
    ).rejects.toBe("文件不在当前 Working Copy 内");
    expect(invoke).toHaveBeenCalledWith("host_reveal_project_file", {
      input: {
        farfoldSessionId: "host-a",
        nativeSessionId: "native-a",
        path: "../outside.md",
      },
    });
  });
  it("opens result files through the same captured Host and native identities", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await openProjectFile(
      { farfoldSessionId: "host-a", nativeSessionId: "native-a" },
      "./report.md",
    );
    expect(invoke).toHaveBeenCalledWith("host_open_project_file", {
      input: {
        farfoldSessionId: "host-a",
        nativeSessionId: "native-a",
        path: "./report.md",
      },
    });
  });
});
