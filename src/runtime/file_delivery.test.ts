import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  FileVerificationSelection,
  fileDelivery,
  localResourcePath,
  reportedFiles,
  type VerifiedFile,
} from "./file_delivery";
import type { ToolCallView } from "./session_types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const result: VerifiedFile = {
  root: "/work",
  path: "report.md",
  resolvedPath: "/work/report.md",
  name: "report.md",
  size: 4,
  sha256: "digest",
  version: "version-one",
};

function call(patch: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: "write-one",
    kind: "edit",
    title: "Write",
    status: "completed",
    locations: [],
    content: [],
    startedAt: 1,
    ...patch,
  };
}

describe("reported file candidates", () => {
  it("uses protocol locations, diff paths and local resources without claiming a disk result", () => {
    expect(
      reportedFiles(
        call({
          locations: [{ path: "report.md" }],
          content: [
            {
              type: "diff",
              path: "report.md",
              oldText: null,
              newText: "partial",
            },
            {
              type: "link",
              uri: "file:///work/chart%20one.png",
              name: "chart",
            },
          ],
        }),
      ),
    ).toEqual([
      { path: "report.md", source: "diff", toolCallId: "write-one" },
      {
        path: "/work/chart one.png",
        source: "resourceLink",
        toolCallId: "write-one",
      },
    ]);
  });

  it("does not infer results from prose, raw input or read/search locations", () => {
    expect(
      reportedFiles(
        call({
          kind: "read",
          locations: [{ path: "source.md" }],
          rawInput: { path: "guessed.md", content: "file" },
          content: [{ type: "text", text: "Saved /private/file.txt" }],
        }),
      ),
    ).toEqual([]);
  });

  it.each(["pending", "in_progress", "failed"])(
    "excludes %s reports",
    (status) => {
      expect(
        reportedFiles(call({ status, locations: [{ path: "report.md" }] })),
      ).toEqual([]);
    },
  );

  it("does not advertise a deleted file as a deliverable", () => {
    expect(
      reportedFiles(
        call({
          kind: "delete",
          content: [
            { type: "diff", path: "gone.md", oldText: "gone", newText: "" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    "https://example.com/out.pdf",
    "file://remote/work/out.pdf",
    "file:///work/out.pdf?secret=x",
    "file:///work/out.pdf#fragment",
    "file:///work/%00bad",
    "file:///work/%ZZ",
    "report.md",
  ])("does not turn %s into local file authority", (uri) => {
    expect(localResourcePath(uri)).toBeNull();
  });
});

describe("selected result verification", () => {
  it("drops late verification after switching the original task or file", async () => {
    let resolve!: (file: VerifiedFile) => void;
    const pending = new Promise<VerifiedFile>((done) => {
      resolve = done;
    });
    const selection = new FileVerificationSelection();
    selection.select({
      threadKey: "task-a",
      root: "/work",
      path: "report.md",
      toolCallId: "write-one",
    });
    const request = selection.verify(() => pending);
    selection.select({
      threadKey: "task-b",
      root: "/other",
      path: "report.md",
      toolCallId: "write-two",
    });
    resolve(result);
    await request;
    expect(selection.current).toMatchObject({
      state: "unverified",
      target: { threadKey: "task-b" },
    });
  });

  it("rechecking clears the previous verified version and preserves the target on failure", async () => {
    const selection = new FileVerificationSelection();
    selection.select({
      threadKey: "task-a",
      root: "/work",
      path: "report.md",
      toolCallId: null,
    });
    await selection.verify(async () => result);
    expect(selection.current?.state).toBe("verified");
    await selection.verify(async () => {
      throw new Error("文件已变化，请重新核实");
    });
    expect(selection.current).toMatchObject({
      state: "failed",
      target: { threadKey: "task-a" },
    });
    expect(selection.current).not.toHaveProperty("file");
  });

  it("does not restore a dismissed selection on a late failure", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<VerifiedFile>((_, fail) => {
      reject = fail;
    });
    const selection = new FileVerificationSelection();
    selection.select({
      threadKey: "a",
      root: "/work",
      path: "report.md",
      toolCallId: null,
    });
    const request = selection.verify(() => pending);
    selection.clear();
    reject(new Error("unreadable"));
    await request;
    expect(selection.current).toBeNull();
  });

  it("sends the exact verified revision to copy, and exports a snapshot through a separate command", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await fileDelivery.copy(result, "/chosen/copy.md");
    expect(invoke).toHaveBeenLastCalledWith("file_delivery_copy", {
      file: result,
      destination: "/chosen/copy.md",
    });
    await fileDelivery.exportText("reported fragment", "/chosen/snapshot.txt");
    expect(invoke).toHaveBeenLastCalledWith("file_delivery_export_text", {
      text: "reported fragment",
      destination: "/chosen/snapshot.txt",
    });
  });
});

it("inspects clicked exact absolute files separately from relative workspace links", async () => {
  vi.mocked(invoke).mockClear();
  await fileDelivery.inspectLink("/work", "/chosen/space name.html");
  expect(invoke).toHaveBeenLastCalledWith("file_delivery_inspect_selected", {
    path: "/chosen/space name.html",
  });
  await fileDelivery.inspectLink("/work", "report.md");
  expect(invoke).toHaveBeenLastCalledWith("file_delivery_inspect", {
    root: "/work",
    path: "report.md",
  });
  await fileDelivery.inspectLink("/work", "../outside.md");
  expect(invoke).toHaveBeenLastCalledWith("file_delivery_inspect", {
    root: "/work",
    path: "../outside.md",
  });
});
