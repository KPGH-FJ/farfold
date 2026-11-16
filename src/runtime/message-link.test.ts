import { describe, expect, it } from "vitest";
import { inlineFilePath, messageLink } from "./message-link";

describe("explicit message file destinations", () => {
  it.each([
    ["/work/game.html", "/work/game.html"],
    ["./notes.md", "./notes.md"],
    ["../delivery/report.pdf", "../delivery/report.pdf"],
    ["report.pdf", "report.pdf"],
    ["README.md:12:3", "README.md"],
    ["src/main.ts:42", "src/main.ts"],
    ["/work/name%20one.md#L2-L4", "/work/name one.md"],
    ["file:///work/game.html", "/work/game.html"],
    ["file://localhost/work/%E6%B8%B8%E6%88%8F.html#L2C3", "/work/游戏.html"],
    ["file:///work/file%3A12.txt", "/work/file:12.txt"],
    ["file:///work/file%23L12", "/work/file#L12"],
    ["C:/work/report.md", "C:/work/report.md"],
    ["C:\\work\\report.md:12:3", "C:\\work\\report.md"],
    ["\\\\?\\C:\\work\\report.md", "\\\\?\\C:\\work\\report.md"],
    ["D:/工作/report%20one.md#L2", "D:/工作/report one.md"],
    ["file:///C:/work/report.md#L2-L4", "C:/work/report.md"],
    ["file://localhost/D:/work/%E6%8A%A5%E5%91%8A.md:12", "D:/work/报告.md"],
    ["file:///C:/work/file%23L12", "C:/work/file#L12"],
    [".\\notes.md", ".\\notes.md"],
  ])(
    "keeps %s as a local path without resolving against the webview",
    (input, path) => {
      expect(messageLink(input)).toEqual({ kind: "file", path });
    },
  );

  it.each([
    "javascript:alert(1)",
    "javascript:foo.js:12",
    "data:text/html,foo",
    "command:open",
    "file://server/work/game.html",
    "file:///work/game.html?query=1",
    "file:///work/game.html#section",
    "file://user:pass@localhost/work/game.html",
    "file:relative.html",
    "//server/share/file.md",
    "file:///work/%00game.html",
    "file:///work/%0agame.html",
    "file:///work/%ZZ.html",
    "#L2",
    "C:relative.md",
    "C:relative.md:12",
    "\\\\server\\share\\report.md",
    "\\\\?\\UNC\\server\\share\\report.md",
    "\\\\.\\PhysicalDrive0",
    "\\\\?\\GLOBALROOT\\Device\\x",
    "file:////server/share/report.md",
    "file:///C:/work/report.md?query=1",
    "file:///C:/work/report.md#section",
    "file:///C:/work/%00report.md",
  ])("does not activate unsupported target %s", (input) => {
    expect(messageLink(input)).toEqual({ kind: "unavailable" });
  });

  it("preserves ordinary web and mail links", () => {
    expect(messageLink("https://example.com/page#part")).toEqual({
      kind: "web",
      url: "https://example.com/page#part",
    });
    expect(messageLink("mailto:hello@example.com")).toEqual({
      kind: "web",
      url: "mailto:hello@example.com",
    });
  });
});

describe("complete inline-code file paths", () => {
  it.each([
    [
      "/Users/tw/Desktop/TR/cat_fishing.html",
      "/Users/tw/Desktop/TR/cat_fishing.html",
    ],
    ["/work/my game/page.html", "/work/my game/page.html"],
    ["./src/main.ts:8:2", "./src/main.ts"],
    ["../report.md#L3-L8", "../report.md"],
    ["file:///work/a%20b.html", "/work/a b.html"],
    ["/work/a%20b.html", "/work/a%20b.html"],
    ["C:/work/report.md", "C:/work/report.md"],
    ["C:\\work\\report.md:12", "C:\\work\\report.md"],
    ["\\\\?\\C:\\work\\report.md", "\\\\?\\C:\\work\\report.md"],
    ["C:\\工作 文件\\a%20b.md", "C:\\工作 文件\\a%20b.md"],
    ["file:///C:/work/a%20b.md#L2", "C:/work/a b.md"],
    [".\\src\\main.ts:8:2", ".\\src\\main.ts"],
    ["..\\report.md#L3-L8", "..\\report.md"],
  ])("recognizes %s without inspecting it", (input, path) =>
    expect(inlineFilePath(input)).toBe(path),
  );

  it.each([
    "cat_fishing.html",
    "Math.random",
    "node /work/game.js",
    "open /work/game.html",
    "./run.sh --flag",
    "/usr/bin/open /work/game.html",
    "./x.sh;open /work/game.html",
    "/work/$(whoami).html",
    "https://example.com/game.html",
    "file:///work/game.html#arbitrary",
    "//server/game.html",
    " /work/game.html",
    "/work/game.html\n",
    "/work/game.html\u0000",
    "C:relative.md",
    "\\\\server\\share\\report.md",
    "\\\\?\\UNC\\server\\share\\report.md",
    "\\\\.\\PhysicalDrive0",
    "\\\\?\\GLOBALROOT\\Device\\x",
    "C:\\run.exe --flag",
    "C:\\run.exe D:\\work\\file.md",
    "C:\\run.exe .\\file.md",
  ])("leaves ordinary code or command %s inert", (input) =>
    expect(inlineFilePath(input)).toBeNull(),
  );
});
