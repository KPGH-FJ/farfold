import { expect, it, vi } from "vitest";
import {
  fileBasename,
  filePathUri,
  isAbsoluteFilePath,
  projectFileUri,
} from "./file_paths";
import {
  fileDelivery,
  localResourcePath,
  reportedFiles,
} from "./file_delivery";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

it.each([
  "/work/中文 #100%.md",
  "C:\\Work Folder\\中文 #100%.md",
  "c:/Work/one?.md",
  "\\\\?\\C:\\Work\\report.md",
])(
  "round-trips explicitly local file names without query, fragment or escaped-byte loss: %s",
  (path) => {
    const uri = filePathUri(path);
    const url = new URL(uri);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(url.hostname).toBe("");
    const expected = path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
    expect(localResourcePath(uri)).toBe(expected);
  },
);
it("preserves POSIX backslash names and joins Windows relative files without inventing authority", () => {
  expect(localResourcePath(filePathUri("/work/a\\b.md"))).toBe("/work/a\\b.md");
  expect(
    localResourcePath(projectFileUri("C:\\work folder", "sub\\a#%.md")),
  ).toBe("C:/work folder/sub/a#%.md");
  expect(fileBasename("C:\\工作\\报告.md")).toBe("报告.md");
  expect(fileBasename("/work/a\\b.md")).toBe("a\\b.md");
});
it("rejects schemes, drive-relative paths, device namespaces and project traversal", () => {
  for (const p of [
    "https://example.com/a",
    "C:relative.md",
    "relative.md",
    "\\\\.\\PhysicalDrive0",
    "\\\\?\\GLOBALROOT\\Device\\x",
    "/work/\0bad",
  ]) {
    expect(isAbsoluteFilePath(p), p).toBe(false);
    expect(() => filePathUri(p), p).toThrow();
  }
  for (const p of ["../out.md", "sub\\..\\out.md", "C:other.md", "D:\\out.md"])
    expect(() => projectFileUri("C:\\work", p)).toThrow();
  expect(localResourcePath("file://other-machine/share/report.md")).toBeNull();
});
it("routes a Windows absolute delivery candidate through explicit file inspection", async () => {
  vi.mocked(invoke).mockClear();
  // The official invoke API always returns a Promise, even for an unused reply.
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await fileDelivery.inspectLink("C:\\work", "D:\\reports\\out.md");
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "file_delivery_inspect_selected",
    { path: "D:\\reports\\out.md" },
  );
  const call: any = {
    toolCallId: "one",
    status: "completed",
    kind: "edit",
    locations: [{ path: "C:\\work\\out.md" }],
    content: [],
  };
  expect(reportedFiles(call)).toEqual([
    { path: "C:\\work\\out.md", toolCallId: "one", source: "location" },
  ]);
});
