import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileArtifact } from "../runtime/artifact_view";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import {
  FileArtifactView,
  FileDifference,
  StaticHtmlPreview,
} from "./FileArtifactView";

const card: FileArtifact = {
  kind: "diff",
  path: "page.html",
  oldText: null,
  newText:
    "<html><head></head><body><script>alert(1)</script><h1>Hello</h1></body></html>",
  scope: "file",
  source: "diff",
  status: "completed",
  time: 1,
};

it("renders an opaque iframe without granting script, same-origin, form or navigation permissions", () => {
  const html = renderToStaticMarkup(
    <StaticHtmlPreview card={{ ...card, scope: "fragment" }} />,
  );
  expect(html).toContain('sandbox=""');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).toContain('srcDoc="');
  expect(html).not.toContain("allow-scripts");
  expect(html).not.toContain("allow-same-origin");
  expect(html).not.toContain("allow-forms");
  expect(html).not.toContain("allow-top-navigation");
  expect(html).toContain(W.previewNote);
  expect(
    renderToStaticMarkup(
      <StaticHtmlPreview
        card={{ ...card, scope: "fragment", source: "edit-input" }}
      />,
    ),
  ).toBe("");
});

it("clearly marks failed argument fragments and omits full webpage preview controls", () => {
  const html = renderToStaticMarkup(
    <FileArtifactView
      card={{
        ...card,
        scope: "fragment",
        source: "edit-input",
        status: "failed",
      }}
      threadKey="a"
    />,
  );
  expect(html).toContain(W.fragmentNote);
  expect(html).toContain(W.fileInput);
  expect(html).toContain(W.fileFailed);
  expect(html).toContain(W.incompleteHtml);
  expect(html).not.toContain(W.pagePreview);
  expect(html).not.toContain("<iframe");
});

it.each(["edit-input", "write-input"] as const)(
  "keeps %s provenance separate from fragment coordinates and pending status",
  (source) => {
    const html = renderToStaticMarkup(
      <FileArtifactView
        card={{ ...card, scope: "fragment", source, status: "in_progress" }}
        threadKey="a"
      />,
    );
    expect(html).toContain(W.fileInput);
    expect(html).toContain("拟写入");
    expect(html).toContain(W.fragmentNote);
    expect(html).toContain(W.filePending);
    expect(html).not.toContain(W.fileReported);
    expect(html).not.toContain("<iframe");
  },
);

it.each(["completed", "failed"] as const)(
  "distinguishes an Agent-reported %s fragment from proposed input",
  (status) => {
    const html = renderToStaticMarkup(
      <FileArtifactView
        card={{ ...card, scope: "fragment", source: "diff", status }}
        threadKey="a"
      />,
    );
    expect(html).toContain(W.fileReported);
    expect(html).toContain("Agent 报告");
    expect(html).toContain("不代表文件当前状态");
    expect(html).toContain(W.fragmentNote);
    expect(html).not.toContain(W.fileInput);
    if (status === "failed") expect(html).toContain(W.fileFailed);
    else {
      expect(html).not.toContain(W.fileFailed);
      expect(html).not.toContain(W.filePending);
    }
  },
);

it("leaves feedback collapsed until requested and exposes truthful viewing and copy controls", () => {
  const html = renderToStaticMarkup(
    <FileArtifactView card={card} threadKey="a" />,
  );
  expect(html).toContain(`aria-label="${W.viewMode}"`);
  expect(html).toContain(`aria-label="${W.copyDiff}"`);
  expect(html).toContain(`aria-label="${W.copyPath}"`);
  expect(html).toContain(
    `aria-label="${W.feedbackOpen}" aria-expanded="false"`,
  );
  expect(html).not.toContain("<textarea");
  expect(html).toContain(W.unifiedDiff);
  expect(html).toContain(W.splitDiff);
});

it("shows real before/after lines in split mode and labels fragment locations accurately", () => {
  const html = renderToStaticMarkup(
    <FileDifference
      card={{
        ...card,
        path: "snippet.ts",
        oldText: "old",
        newText: "new",
        scope: "fragment",
      }}
      split
      onLine={() => {}}
    />,
  );
  expect(html).toContain('class="artifact-split-code"');
  expect(html).toContain(`aria-label="${W.fileBefore} · ${W.fragmentLine(1)}"`);
  expect(html).toContain(`aria-label="${W.fileAfter} · ${W.fragmentLine(1)}"`);
  expect(html).toContain("<code>old</code>");
  expect(html).toContain("<code>new</code>");
  const noOriginal = renderToStaticMarkup(
    <FileDifference card={card} split onLine={() => {}} />,
  );
  expect(noOriginal).toContain(W.missingOriginal);
});

it("highlights only the selected side and range in both difference layouts", () => {
  for (const split of [false, true]) {
    const html = renderToStaticMarkup(
      <FileDifference
        card={{
          ...card,
          oldText: "one\ntwo\nthree",
          newText: "one\ntwo\nthree",
        }}
        split={split}
        onLine={() => {}}
        selection={{ side: "after", line: 2, endLine: 3 }}
      />,
    );
    expect(html.match(/selected-line/g)).toHaveLength(2);
  }
});
