import { describe, expect, it } from "vitest";
import {
  filterCommands,
  filterFiles,
  matchFile,
  mentionAnchor,
  mentionQuery,
  slashQuery,
} from "./commands";

describe("slashQuery", () => {
  it("matches a leading single token", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("hello /rev")).toBeNull();
    expect(slashQuery("/rev now")).toBeNull();
    expect(slashQuery("plain")).toBeNull();
  });
});

describe("filterCommands", () => {
  const commands = [
    { name: "review", description: "r" },
    { name: "review-branch" },
    { name: "compact" },
  ];
  it("prefix-filters case-insensitively", () => {
    expect(filterCommands(commands, "rev").map((c) => c.name)).toEqual([
      "review",
      "review-branch",
    ]);
    expect(filterCommands(commands, "C")).toEqual([{ name: "compact" }]);
    expect(filterCommands(commands, "")).toHaveLength(3);
  });
});

describe("mentionAnchor", () => {
  it("anchors a trailing @ at start or after whitespace", () => {
    expect(mentionAnchor("@")).toBe(0);
    expect(mentionAnchor("fix @")).toBe(4);
    expect(mentionAnchor("a@b")).toBe(-1);
    expect(mentionAnchor("mail@")).toBe(-1);
    expect(mentionAnchor("")).toBe(-1);
  });
});

describe("mentionQuery", () => {
  it("reads text after the anchor until whitespace", () => {
    expect(mentionQuery("@src/ma", 0)).toBe("src/ma");
    expect(mentionQuery("hi @READ", 3)).toBe("READ");
    expect(mentionQuery("@a b", 0)).toBeNull();
    expect(mentionQuery("no anchor", -1)).toBeNull();
  });
});

describe("filterFiles", () => {
  const files = [
    "src/main.ts",
    "src/app.tsx",
    "README.md",
    "deep/nested/dir/file.ts",
  ];
  it("matches in-order subsequence, basename first", () => {
    expect(filterFiles(files, "main")).toContain("src/main.ts");
    expect(filterFiles(files, "app")[0]).toBe("src/app.tsx");
    expect(filterFiles(files, "")).toHaveLength(4);
    expect(filterFiles(files, "zzz")).toEqual([]);
  });
  it("matchFile is case-insensitive subsequence", () => {
    expect(matchFile("README.md", "rme")).toBe(true);
    expect(matchFile("README.md", "mdr")).toBe(false);
  });
});
