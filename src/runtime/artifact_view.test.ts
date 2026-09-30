import { describe, expect, it } from "vitest";
import { applyUpdate, freshThreadState } from "./sessions";
import { paneCards } from "./artifacts";
import {
  artifactFiles,
  canPreviewHtml,
  lineDiff,
  splitDiffRows,
  selectedArtifactFile,
  staticPreviewDocument,
  STATIC_PREVIEW_CSP,
  type FileArtifact,
} from "./artifact_view";

const html =
  "<html><head><style>body{color:red}</style></head><body><h1>Hello</h1></body></html>";
function card(patch: Partial<FileArtifact> = {}): FileArtifact {
  return {
    kind: "diff",
    path: "page.html",
    oldText: null,
    newText: html,
    scope: "file",
    source: "diff",
    status: "completed",
    time: 1,
    ...patch,
  };
}

describe("real file reports", () => {
  it("preserves report provenance without inferring complete files from diffs or arguments", () => {
    const thread = freshThreadState("a:/tmp:s", "a", "/tmp", "s");
    for (const [id, body] of Object.entries({
      full: {
        content: [
          { type: "diff", path: "full.html", oldText: "old", newText: html },
        ],
      },
      edit: {
        rawInput: { filePath: "edit.html", oldString: "old", newString: html },
      },
      append: { rawInput: { path: "append.html", content: html } },
    }))
      applyUpdate(thread, {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: id,
        kind: "edit",
        status: "failed",
        ...body,
      });
    const files = artifactFiles(paneCards(thread));
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({
      scope: "fragment",
      source: "diff",
      status: "failed",
    });
    expect(files[1]).toMatchObject({
      scope: "fragment",
      source: "edit-input",
      status: "failed",
    });
    expect(files[2]).toMatchObject({
      scope: "fragment",
      source: "write-input",
      status: "failed",
    });
    expect(files.map(canPreviewHtml)).toEqual([true, false, false]);
  });

  it.each([true, false])(
    "keeps replacement diff coordinates local with raw input present=%s",
    (withInput) => {
      const thread = freshThreadState("a:/tmp:s", "a", "/tmp", "s");
      const diff = {
        type: "diff",
        path: "/tmp/note.md",
        oldText: "V6A",
        newText: "V6B",
      };
      applyUpdate(thread, {
        sessionUpdate: "tool_call",
        toolCallId: "replace",
        kind: "edit",
        status: "completed",
        locations: [{ path: diff.path, line: 42 }],
        ...(withInput
          ? {
              rawInput: {
                filePath: diff.path,
                oldString: diff.oldText,
                newString: diff.newText,
              },
            }
          : {}),
        content: [diff],
      });
      const files = artifactFiles(paneCards(thread));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: diff.path,
        oldText: diff.oldText,
        newText: diff.newText,
        source: "diff",
        scope: "fragment",
      });
      // A tool location is not a declared starting offset for either side of a diff.
      expect(
        lineDiff(files[0].oldText, files[0].newText).map(
          (row) => row.oldLine ?? row.newLine,
        ),
      ).toEqual([1, 1]);
    },
  );

  it("keeps latest reported content by path and disambiguates a real file named output", () => {
    const first = card({ path: "output", newText: "first" });
    const last = card({ path: "output", newText: "last", time: 3 });
    const files = artifactFiles([
      first,
      {
        kind: "command",
        title: "check",
        output: "actual output",
        failed: false,
        time: 2,
      },
      last,
    ]);
    expect(files).toEqual([last]);
    expect(selectedArtifactFile(files, "file:output")).toBe(last);
    expect(selectedArtifactFile(files, "output")).toBeNull();
    expect(selectedArtifactFile(files, null)).toBe(last);
  });
});

describe("line differences", () => {
  it("keeps uneven replacements and unchanged locations honest in side-by-side view", () => {
    const rows = splitDiffRows(
      lineDiff("one\nold\nextra\nend", "one\nnew\nend"),
    );
    expect(
      rows.map((row) => [
        row.before?.oldLine ?? null,
        row.after?.newLine ?? null,
      ]),
    ).toEqual([
      [1, 1],
      [2, 2],
      [3, null],
      [4, 3],
    ]);
    expect(
      rows.flatMap((row) => (row.before ? [row.before.text] : [])).join("\n"),
    ).toBe("one\nold\nextra\nend");
    expect(
      rows.flatMap((row) => (row.after ? [row.after.text] : [])).join("\n"),
    ).toBe("one\nnew\nend");
    expect(splitDiffRows(lineDiff(null, "new"))).toEqual([
      {
        before: null,
        after: { kind: "add", oldLine: null, newLine: 1, text: "new" },
      },
    ]);
  });
  it("aligns unchanged lines while keeping original and updated line numbers", () => {
    expect(lineDiff("one\ntwo\nthree", "one\nnew\nthree")).toEqual([
      { kind: "same", oldLine: 1, newLine: 1, text: "one" },
      { kind: "remove", oldLine: 2, newLine: null, text: "two" },
      { kind: "add", oldLine: null, newLine: 2, text: "new" },
      { kind: "same", oldLine: 3, newLine: 3, text: "three" },
    ]);
    expect(lineDiff(null, "new")).toEqual([
      { kind: "add", oldLine: null, newLine: 1, text: "new" },
    ]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("preserves exact text through large replacement fallback including trailing lines", () => {
    const old =
      Array.from({ length: 1100 }, (_, i) => `old${i}`).join("\n") + "\n";
    const next =
      Array.from({ length: 1100 }, (_, i) => `next${i}`).join("\n") + "\n";
    const rows = lineDiff(old, next);
    expect(
      rows
        .filter((r) => r.kind !== "add")
        .map((r) => r.text)
        .join("\n"),
    ).toBe(old);
    expect(
      rows
        .filter((r) => r.kind !== "remove")
        .map((r) => r.text)
        .join("\n"),
    ).toBe(next);
    expect(rows.at(-1)).toMatchObject({
      kind: "same",
      oldLine: 1101,
      newLine: 1101,
    });
  });
});

describe("static HTML boundary", () => {
  it("previews reported HTML document structure without asserting file completeness", () => {
    expect(canPreviewHtml(card())).toBe(true);
    expect(canPreviewHtml(card({ scope: "fragment" }))).toBe(true);
    for (const patch of [
      { scope: "fragment" as const, source: "edit-input" as const },
      { path: "page.txt" },
      { newText: "<h1>fragment</h1>" },
      { newText: `<!--${html}-->` },
      { newText: `<script>const text = '${html}'</script>` },
    ])
      expect(canPreviewHtml(card(patch))).toBe(false);
  });

  it("places restrictive CSP first and removes navigation metadata and links", () => {
    const source =
      '<meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"><a/href="https://example.com">link</a><a xlink:href="https://example.com">link2</a><script>alert(1)</script><img src="https://example.com/p.png">';
    const doc = staticPreviewDocument(source);
    expect(
      doc.startsWith(
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${STATIC_PREVIEW_CSP}"`,
      ),
    ).toBe(true);
    expect(doc).not.toMatch(
      /http-equiv="refresh"|<base\b|(?:xlink:)?href\s*=/i,
    );
    for (const policy of [
      "default-src 'none'",
      "script-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ])
      expect(STATIC_PREVIEW_CSP).toContain(policy);
    expect(STATIC_PREVIEW_CSP).not.toContain("https:");
    expect(doc).toContain("<script>alert(1)</script>"); // Execution is denied by CSP and iframe sandbox, not implied by text removal.
  });

  it("does not create navigation tags by joining around a removed tag", () => {
    const doc = staticPreviewDocument(
      '<me<meta>ta http-equiv="refresh" content="0;url=https://example.com">',
    );
    expect(doc).not.toContain('<meta http-equiv="refresh"');
  });
});
