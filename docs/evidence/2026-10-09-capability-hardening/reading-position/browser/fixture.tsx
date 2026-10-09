import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { VisualFilePreview } from "/src/components/VisualFilePreview";
import { WorkbookFilePreview } from "/src/components/WorkbookFilePreview";
import { DocxFilePreview } from "/src/components/DocxFilePreview";
import { cellAddress } from "/src/runtime/workbook_view";
import { WORKBOOK_STRINGS as W } from "/src/runtime/workbook_strings";
import { DOCUMENT_STRINGS as D } from "/src/runtime/document_strings";
import { VISUAL_PREVIEW_STRINGS as V } from "/src/runtime/visual_preview";
import type { VerifiedFile } from "/src/runtime/file_delivery";
import { XlsxError } from "/src/runtime/xlsx_types";
import type { WorkbookPreview } from "/src/runtime/xlsx_types";
import type { DocxPreview } from "/src/runtime/docx_types";
import type { PreviewReadingPositionRef } from "/src/runtime/preview_reading_position";
import "/src/styles.css";
import "/src/styles-artifact.css";
const results: any[] = [],
  calls: any[] = [],
  ready: any[] = [];
const root = createRoot(document.querySelector("#app")!);
const pause = () => new Promise((r) => setTimeout(r, 20));
async function until(fn: () => unknown) {
  for (let i = 0; i < 800; i++) {
    if (fn()) return;
    await pause();
  }
  throw new Error(
    "wait expired " +
      document.querySelector("#app")?.textContent?.slice(0, 1500),
  );
}
function check(name: string, ok: unknown, detail?: unknown) {
  results.push({
    name,
    ok: !!ok,
    detail: detail === undefined ? undefined : structuredClone(detail),
  });
  if (!ok) throw new Error(name);
}
function mount(node: React.ReactNode) {
  flushSync(() => root.render(<StrictMode>{node}</StrictMode>));
}
function click(label: string) {
  const b = [...document.querySelectorAll("button")].find(
    (x) => x.textContent?.trim() === label,
  );
  if (!b || b.disabled) throw new Error("button unavailable " + label);
  flushSync(() => b.click());
}
const file = (ext: string, v = "v1"): VerifiedFile => ({
  root: "/fixture",
  resolvedPath: "/fixture/sample." + ext,
  path: "/fixture/sample." + ext,
  name: "sample." + ext,
  version: v,
  sha256: v,
  size: 1,
});
let small = false,
  deferred: any = null;
(globalThis as any).fixture = {
  capture: async (f: any, s: any) => {
    calls.push({ capture: f.version, aborted: s.aborted });
    return { file: f };
  },
  workbook: async (c: any, id: any, s: any) => {
    if (deferred)
      return await new Promise(
        (r) => (deferred.resolve = () => r(book(c.file, id))),
      );
    return book(c.file, id, small ? 8 : 220, small ? 4 : 30);
  },
  document: async (c: any) => doc(c.file, small ? 21 : 45),
};
function book(
  file: VerifiedFile,
  id = "first",
  row = 220,
  column = 30,
): WorkbookPreview {
  return {
    date1904: false,
    sheets: [
      { id: "first", name: "First", state: "visible" },
      { id: "second", name: "Second", state: "visible" },
    ],
    styles: [{ numFmt: "General", font: {}, borders: {} }],
    warnings: [],
    sheet: {
      id,
      cells: [
        {
          reference: cellAddress(row, column),
          row,
          column,
          type: "text",
          value: `${file.version}-${id}`,
          raw: `${file.version}-${id}`,
          cacheState: "notFormula",
          formulaPresent: false,
          formula: null,
          display: null,
          styleId: 0,
        },
      ],
      rows: [],
      columns: [],
      merges: [],
    },
  };
}
function doc(file: VerifiedFile, count = 45): DocxPreview {
  const blocks = Array.from({ length: count }, (_, i) => ({
    kind: "paragraph" as const,
    id: `p${i}`,
    style: {},
    runs: [
      { kind: "text" as const, style: {}, text: `${file.version}-note-${i}` },
    ],
  }));
  return {
    file,
    blocks: [
      {
        kind: "paragraph",
        id: "body",
        style: {},
        runs: [{ kind: "text", style: {}, text: `${file.version}-body` }],
      },
    ],
    stories: [{ id: "note:7", kind: "footnote", noteId: "7", blocks }],
    images: [],
    warnings: [],
    partial: false,
  };
}

async function run() {
  const wf = file("xlsx"),
    ref: PreviewReadingPositionRef = {
      current: {
        root: wf.root,
        resolvedPath: wf.resolvedPath,
        kind: "workbook",
        sheet: { id: "second", name: "Second" },
        row: 201,
        column: 25,
        showHidden: false,
      },
    };
  mount(<WorkbookFilePreview file={wf} active readingPosition={ref} />);
  await until(() => document.querySelector('[data-cell="AD220"] button'));
  check("StrictMode surviving effect captures once", calls.length === 1, calls);
  check(
    "saved worksheet and row/column window restored",
    (document.querySelector("select") as HTMLSelectElement).value ===
      "second" && !!document.querySelector('[data-cell="Y201"]'),
  );
  flushSync(() =>
    (
      document.querySelector('[data-cell="AD220"] button') as HTMLButtonElement
    ).click(),
  );
  check(
    "old cell detail is actually open",
    !!document.querySelector(".workbook-cell-detail"),
  );
  mount(null);
  small = true;
  const wf2 = file("xlsx", "v2");
  mount(<WorkbookFilePreview file={wf2} active readingPosition={ref} />);
  await until(() => document.querySelector('[data-cell="D8"] button'));
  check(
    "new shorter revision clamps actual bounds",
    ref.current?.kind === "workbook" &&
      ref.current.row === 8 &&
      ref.current.column === 4,
    ref.current,
  );
  check(
    "version change clears old cell detail and contents",
    !document.querySelector(".workbook-cell-detail") &&
      !document.querySelector("#app")!.textContent?.includes("v1-second"),
  );
  mount(
    <WorkbookFilePreview file={wf2} active={false} readingPosition={ref} />,
  );
  check(
    "hidden workbook withdraws grid",
    !document.querySelector("[data-cell]"),
  );
  mount(<WorkbookFilePreview file={wf2} active readingPosition={ref} />);
  await until(() => document.querySelector('[data-cell="D8"]'));
  check(
    "hide/show retains valid window",
    ref.current?.kind === "workbook" && ref.current.row === 8,
  );
  mount(null);
  deferred = {};
  const wf3 = file("xlsx", "v3");
  mount(<WorkbookFilePreview file={wf3} active readingPosition={ref} />);
  await until(() => deferred.resolve);
  click(W.cancel);
  deferred.resolve();
  await pause();
  check(
    "cancelled late workbook does not display or overwrite location",
    !document.querySelector("[data-cell]") &&
      ref.current?.kind === "workbook" &&
      ref.current.row === 8,
  );
  deferred = null;
  mount(null);
  const officeStatus: any[] = [],
    originalCapture = (globalThis as any).fixture.capture;
  let rejectCapture: any;
  const pendingFile = file("xlsx", "pending");
  const countBefore = calls.length;
  (globalThis as any).fixture.capture = (f: any, s: any) => {
    calls.push({ capture: f.version, aborted: s.aborted });
    return new Promise((_, no) => (rejectCapture = no));
  };
  const pendingView = (active: boolean) => (
    <WorkbookFilePreview
      file={pendingFile}
      active={active}
      readingPosition={ref}
      onStatus={(s) => officeStatus.push(s)}
    />
  );
  mount(pendingView(true));
  await until(() => rejectCapture);
  mount(pendingView(false));
  mount(pendingView(true));
  await pause();
  check(
    "hiding during real component capture wait reuses one outstanding read",
    calls.length === countBefore + 1,
  );
  rejectCapture(new XlsxError("readPending"));
  await until(() => officeStatus.at(-1)?.code === "readPending");
  mount(pendingView(false));
  mount(pendingView(true));
  await pause();
  check(
    "late pending reported and no visibility-driven retry",
    officeStatus.at(-1)?.code === "readPending" &&
      calls.length === countBefore + 1,
  );
  (globalThis as any).fixture.capture = originalCapture;
  click(W.retry);
  await until(() => document.querySelector("[data-cell]"));
  check(
    "explicit retry can recover pending receipt",
    calls.length === countBefore + 2 && officeStatus.at(-1)?.state === "ready",
  );
  mount(null);
  small = false;
  const df = file("docx"),
    dr: PreviewReadingPositionRef = {
      current: {
        root: df.root,
        resolvedPath: df.resolvedPath,
        kind: "document",
        story: { id: "note:7", kind: "footnote", noteId: "7" },
        segment: 2,
      },
    };
  mount(<DocxFilePreview file={df} active readingPosition={dr} />);
  await until(() =>
    document.querySelector("#app")!.textContent?.includes("v1-note-40"),
  );
  check(
    "document story and segment restored",
    !document.querySelector("#app")!.textContent?.includes("v1-body") &&
      dr.current?.kind === "document" &&
      dr.current.segment === 2,
  );
  mount(<DocxFilePreview file={df} active={false} readingPosition={dr} />);
  check(
    "hidden document removes content",
    !document.querySelector("#app")!.textContent?.includes("v1-note"),
  );
  mount(<DocxFilePreview file={df} active readingPosition={dr} />);
  await until(() =>
    document.querySelector("#app")!.textContent?.includes("v1-note-40"),
  );
  check(
    "document hide/show retains segment",
    dr.current?.kind === "document" && dr.current.segment === 2,
  );
  mount(null);
  small = true;
  const df2 = file("docx", "v2");
  mount(<DocxFilePreview file={df2} active readingPosition={dr} />);
  await until(() =>
    document.querySelector("#app")!.textContent?.includes("v2-note-20"),
  );
  check(
    "shortened story clamps and never shows old text",
    dr.current?.kind === "document" &&
      dr.current.segment === 1 &&
      !document.querySelector("#app")!.textContent?.includes("v1-note"),
  );
  mount(null);
  const pdf = async (path: string, version: string) => {
    const bytes = new Uint8Array(await (await fetch(path)).arrayBuffer());
    return {
      file: { ...file("pdf", version), size: bytes.length },
      mimeType: "application/pdf",
      data: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")),
    };
  };
  const p = await pdf(
      "/src/runtime/fixtures/pdf-preview/mixed-two-pages.pdf",
      "p1",
    ),
    pr: PreviewReadingPositionRef = {
      current: {
        root: p.file.root,
        resolvedPath: p.file.resolvedPath,
        kind: "pdf",
        page: 2,
      },
    };
  const report = (v: any) =>
    ready.push({ version: v.source.file.version, location: v.location });
  mount(
    <VisualFilePreview
      preview={p}
      active
      readingPosition={pr}
      onReadiness={report}
    />,
  );
  check(
    "PDF readiness absent until real worker pixels",
    ready.at(-1)?.location === null,
  );
  await until(() => ready.at(-1)?.location?.page === 2);
  check(
    "real PDF worker restores second page",
    document.querySelector("canvas")!.width > 0 &&
      pr.current?.kind === "pdf" &&
      pr.current.page === 2,
  );
  mount(null);
  check(
    "unmount withdraws PDF feedback readiness",
    ready.at(-1)?.location === null,
  );
  const p2 = await pdf(
    "/src/runtime/fixtures/pdf-preview/embedded-chinese.pdf",
    "p2",
  );
  mount(
    <VisualFilePreview
      preview={p2}
      active
      readingPosition={pr}
      onReadiness={report}
    />,
  );
  check(
    "revised PDF withdraws readiness before rendering",
    ready.at(-1)?.location === null,
  );
  await until(
    () => ready.at(-1)?.version === "p2" && ready.at(-1)?.location?.page === 1,
  );
  check(
    "real PDF worker clamps to actual one-page revision",
    pr.current?.kind === "pdf" &&
      pr.current.page === 1 &&
      ready.at(-1).location.pageCount === 1,
    ready.at(-1),
  );
  mount(
    <VisualFilePreview
      preview={p2}
      active={false}
      readingPosition={pr}
      onReadiness={report}
    />,
  );
  check(
    "hidden PDF clears pixels/readiness but retains location",
    document.querySelector("canvas")!.width === 0 &&
      ready.at(-1)?.location === null &&
      pr.current?.kind === "pdf" &&
      pr.current.page === 1,
  );
  mount(
    <VisualFilePreview
      preview={p2}
      active
      readingPosition={pr}
      onReadiness={report}
    />,
  );
  await until(() => ready.at(-1)?.location?.page === 1);
  check(
    "shown PDF redraws before ready",
    document.querySelector("canvas")!.width > 0,
  );
  document.documentElement.dataset.capture = "position-pdf";
  await until(
    () => document.documentElement.dataset.captured === "position-pdf",
  );
  mount(null);
  check("final PDF unmount revokes readiness", ready.at(-1)?.location === null);
}
run()
  .then(() => finish())
  .catch((e) => finish(String(e)));
function finish(error?: string) {
  document.querySelector("#result")!.textContent = JSON.stringify(
    {
      passed: !error,
      results,
      error,
      calls,
      ready,
      boundary:
        "Real React StrictMode and PDF worker; Office parser/IPC mocked. No native app or Agent.",
    },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
