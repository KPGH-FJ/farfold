import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DocxFilePreview } from "/src/components/DocxFilePreview";
import "/src/styles.css";
import "/src/styles-content.css";
import "/src/product-shell.css";
const mount = createRoot(document.querySelector("#app")!);
document
  .querySelector("#app")!
  .setAttribute(
    "style",
    "max-width:900px;margin:24px auto;padding:20px;background:var(--bg,#fff)",
  );
const results: any[] = [],
  calls: any[] = [],
  pending: any[] = [],
  workers: any[] = [];
let defer = false;
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: URL | string, options?: WorkerOptions) {
    super(url, options);
    workers.push({ created: String(url), closed: false });
    (this as any)._record = workers.at(-1);
  }
  terminate() {
    (this as any)._record.closed = true;
    super.terminate();
  }
};
const blobUrls = new Set<string>();
const createURL = URL.createObjectURL.bind(URL),
  revokeURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (v) => {
  const u = createURL(v);
  blobUrls.add(u);
  return u;
};
URL.revokeObjectURL = (u) => {
  blobUrls.delete(u);
  return revokeURL(u);
};
const captures = await (await fetch("../browser/captures.json")).json();
let current = captures["docx-compatibility/01-unicode-lists"];
(window as any).__TAURI_INTERNALS__ = {
  invoke(command: string, args: any) {
    calls.push({ command, version: args.file.version });
    if (command !== "file_delivery_read_docx") throw Error("unexpected IPC");
    const copy = structuredClone(current);
    return defer
      ? new Promise((r) => pending.push(() => r(copy)))
      : Promise.resolve(copy);
  },
};
const pause = () =>
  new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
const text = () => document.querySelector("#app")!.textContent!;
async function until(test: () => unknown) {
  for (let i = 0; i < 180; i++) {
    if (test()) return;
    await pause();
  }
  throw Error("UI wait expired: " + text().slice(0, 400));
}
function check(name: string, ok: unknown, detail?: unknown) {
  results.push({
    name,
    passed: !!ok,
    ...(detail === undefined ? {} : { detail }),
  });
  if (!ok) throw Error(name);
}
function render(active = true, key = current.file.version) {
  flushSync(() =>
    mount.render(
      <StrictMode>
        <DocxFilePreview key={key} file={current.file} active={active} />
      </StrictMode>,
    ),
  );
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
}
function press(label: string) {
  const b = button(label);
  check("reachable " + label, !!b && !b.disabled);
  b.click();
}
async function shot(label: string) {
  document.documentElement.dataset.capture = label;
  for (
    let i = 0;
    i < 100 && document.documentElement.dataset.captured !== label;
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
}
try {
  render();
  await until(() => text().includes("兼容性纪要"));
  check("StrictMode one bounded read", calls.length === 1, calls.length);
  check(
    "zero false empty literal content",
    text().includes("0") &&
      text().includes("false") &&
      text().includes("  保留  两处空格  "),
  );
  const bold = [...document.querySelectorAll("span")].find(
      (s) => s.textContent === "加粗文字",
    )!,
    italic = [...document.querySelectorAll("span")].find(
      (s) => s.textContent === "斜体 café",
    )!;
  check(
    "actual computed bold and italic",
    Number(getComputedStyle(bold).fontWeight) >= 600 &&
      getComputedStyle(italic).fontStyle === "italic",
  );
  const labels = [...document.querySelectorAll(".document-list-label")].map(
    (n) => n.textContent!.trim(),
  );
  check(
    "numeric list 1 2 3",
    JSON.stringify(labels.slice(0, 3)) === JSON.stringify(["1.", "2.", "3."]),
    labels,
  );
  await shot("docx-writer-lists");
  check(
    "bullet labels contain no private-use fallback glyph",
    labels.slice(3).every((t) => !/[\uE000-\uF8FF]/.test(t)),
    labels.slice(3),
  );
  current = captures["docx-compatibility/02-table-images-stories"];
  render();
  await until(() => text().includes("表格与图片记录"));
  await until(
    () =>
      document.querySelectorAll("img").length === 2 &&
      [...document.querySelectorAll("img")].every(
        (i) => i.complete && i.naturalWidth === 160,
      ),
  );
  check(
    "two actual images drawn",
    document.querySelectorAll("img").length === 2,
  );
  check(
    "empty cell remains visibly blank",
    document
      .querySelector('[data-document-cell="2:1"]')!
      .textContent!.trim() === "",
  );
  check(
    "table actual horizontal and vertical span",
    !!document.querySelector('td[colspan="2"]') &&
      !!document.querySelector('td[rowspan="2"]'),
  );
  await shot("docx-writer-table-images");
  const surface = document.querySelector(".document-surface")!;
  surface.scrollTop = surface.scrollHeight;
  await pause();
  await shot("docx-writer-jpeg");
  surface.scrollTop = 0;
  await pause();
  const merged = document.querySelector<HTMLButtonElement>(
    '[data-document-cell="0:0"]',
  )!;
  merged.focus();
  merged.click();
  await until(() => !!document.querySelector(".document-cell-detail"));
  check(
    "merged cell full detail and focus",
    text().includes("横向合并") &&
      text().includes("合并范围：第 1–1 行，第 1–2 列") &&
      document.activeElement ===
        document.querySelector(".document-cell-detail"),
  );
  press("返回表格");
  await pause();
  check(
    "return focus to original merged cell",
    document.activeElement ===
      document.querySelector('[data-document-cell="0:0"]'),
  );

  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="文档区域"]',
  )!;
  const header = [...select.options].find((o) =>
    o.textContent!.startsWith("页眉"),
  )!;
  select.value = header.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => text().includes("公开兼容性样本 页眉"));
  check("header isolated from body", !text().includes("表格与图片记录"));
  const footer = [...select.options].find((o) =>
    o.textContent!.startsWith("页脚"),
  )!;
  select.value = footer.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => text().includes("公开兼容性样本 页脚"));
  check("footer isolated", !text().includes("公开兼容性样本 页眉"));
  current = captures["docx-compatibility/03-sections"];
  render();
  await until(() => text().includes("分节项目记录"));
  check("future body blocks windowed", !text().includes("记录 32"));
  press("下一部分");
  await until(() => text().includes("记录 32"));
  check("second group shown", !text().includes("分节项目记录"));
  const before = calls.length;
  render(false);
  await pause();
  check("hidden withdraws body", !document.querySelector(".document-surface"));
  render(true);
  await until(() => text().includes("分节项目记录"));
  check("ready cache reused on reveal", calls.length === before);
  defer = true;
  current = {
    ...captures["docx-fixtures/01-text-values"],
    file: {
      ...captures["docx-fixtures/01-text-values"].file,
      version: "delayed-old",
    },
  };
  render();
  await until(() => pending.length === 1);
  press("取消预览");
  await pause();
  pending.shift()();
  await pause();
  check(
    "cancelled old receipt never draws",
    !document.querySelector(".document-surface") && text().includes("已取消"),
  );
  defer = false;
  press("重新预览");
  await until(() => text().includes("after empty"));
  check("retry reaches body", !!document.querySelector(".document-surface"));
  defer = true;
  current = {
    ...captures["docx-fixtures/01-text-values"],
    file: {
      ...captures["docx-fixtures/01-text-values"].file,
      version: "stale-old",
    },
  };
  render();
  await until(() => pending.length === 1);
  defer = false;
  current = captures["docx-fixtures/02-style-inheritance"];
  render();
  await until(() => text().includes("inherits bold"));
  pending.shift()();
  await pause();
  check(
    "old version result cannot replace current content",
    !text().includes("after empty"),
  );
  const changed = (source: any, xml: string, version: string) => ({
    ...source,
    file: { ...source.file, version },
    parts: source.parts.map((p: any) =>
      p.name === "word/document.xml"
        ? {
            ...p,
            data: btoa(
              Array.from(new TextEncoder().encode(xml), (c) =>
                String.fromCharCode(c),
              ).join(""),
            ),
          }
        : p,
    ),
  });
  const simple = captures["docx-fixtures/01-text-values"];
  const original = new TextDecoder().decode(
    Uint8Array.from(
      atob(simple.parts.find((p: any) => p.name === "word/document.xml").data),
      (c) => c.charCodeAt(0),
    ),
  );
  current = changed(
    simple,
    original.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      '<w:body><w:p><w:pPr><w:ind w:left="-2400" w:firstLine="-2400"/></w:pPr><w:r><w:t>FIRST-VISIBLE</w:t></w:r></w:p></w:body>',
    ),
    "negative-indent",
  );
  render();
  await until(() => text().includes("FIRST-VISIBLE"));
  const firstSpan = [...document.querySelectorAll("span")].find(
    (s) => s.textContent === "FIRST-VISIBLE",
  )!;
  const firstRange = document.createRange();
  firstRange.setStart(firstSpan.firstChild!, 0);
  firstRange.setEnd(firstSpan.firstChild!, 1);
  const left = firstRange.getBoundingClientRect().left,
    surfaceLeft = document
      .querySelector(".document-surface")!
      .getBoundingClientRect().left;
  check(
    "negative indents cannot clip first content character",
    left >= surfaceLeft,
    { left, surfaceLeft },
  );
  const pictureCapture = captures["docx-fixtures/05-inline-png-jpeg"];
  const pictureXml = new TextDecoder().decode(
    Uint8Array.from(
      atob(
        pictureCapture.parts.find((p: any) => p.name === "word/document.xml")
          .data,
      ),
      (c) => c.charCodeAt(0),
    ),
  );
  const drawing = pictureXml.match(/<w:drawing>[\s\S]*?<\/w:drawing>/)![0];
  current = changed(
    pictureCapture,
    pictureXml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      `<w:body><w:p>${`<w:r>${drawing}</w:r>`.repeat(3)}</w:p></w:body>`,
    ),
    "shared-image",
  );
  render();
  await until(
    () =>
      document.querySelectorAll("img").length === 3 &&
      [...document.querySelectorAll("img")].every(
        (i) => i.complete && i.naturalWidth === 8,
      ),
  );
  check(
    "repeated resource shares one Blob URL",
    new Set([...document.querySelectorAll("img")].map((i) => i.src)).size ===
      1 && blobUrls.size === 1,
  );
  const oldSharedUrl = document.querySelector<HTMLImageElement>("img")!.src;
  render(false);
  await pause();
  check("hidden releases shared image URL", blobUrls.size === 0);
  render(true);
  await until(
    () =>
      document.querySelectorAll("img").length === 3 &&
      [...document.querySelectorAll("img")].every(
        (i) => i.complete && i.naturalWidth === 8,
      ),
  );
  check(
    "revealed images share a fresh decoded URL",
    blobUrls.size === 1 &&
      new Set([...document.querySelectorAll("img")].map((i) => i.src)).size ===
        1 &&
      document.querySelector<HTMLImageElement>("img")!.src !== oldSharedUrl,
  );

  let rows = "";
  for (let r = 0; r < 25; r++) {
    let cells = "";
    for (let c = 0; c < 14; c++) {
      if (r >= 18 && r <= 21 && c > 10) continue;
      const merged = r >= 18 && r <= 21 && c === 10;
      const pr = merged
        ? `<w:tcPr><w:gridSpan w:val="4"/><w:vMerge${r === 18 ? ' w:val="restart"' : ""}/></w:tcPr>`
        : "";
      const value = merged
        ? r === 18
          ? "MERGE-ORIGIN"
          : ""
        : `row-${r + 1}-col-${c + 1}`;
      cells += `<w:tc>${pr}<w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
    }
    rows += `<w:tr>${cells}</w:tr>`;
  }
  const grid =
    "<w:tblGrid>" + '<w:gridCol w:w="1800"/>'.repeat(14) + "</w:tblGrid>";
  current = changed(
    simple,
    original.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      `<w:body><w:tbl>${grid}${rows}</w:tbl></w:body>`,
    ),
    "cross-window-table",
  );
  render();
  await until(() => text().includes("row-1-col-1"));
  press("下一组行");
  press("下一组列");
  await until(() => text().includes("当前显示第 21–25 行，第 13–14 列"));
  check(
    "cross-window merge retains original content and disclosure",
    text().includes("MERGE-ORIGIN") &&
      text().includes("合并范围跨越当前显示范围"),
  );
  const continuation = document.querySelector<HTMLButtonElement>(
    '[data-document-cell="20:12"]',
  )!;
  continuation.click();
  await until(() => !!document.querySelector(".document-cell-detail"));
  check(
    "cross-window detail names original anchor",
    text().includes("第 19 行，第 11 列") &&
      text().includes("合并范围：第 19–22 行，第 11–14 列"),
  );
  press("返回表格");
  await pause();
  check(
    "cross-window return focus current visible coordinate",
    document.activeElement ===
      document.querySelector('[data-document-cell="20:12"]'),
  );
  await shot("docx-cross-window-table");
  const longText = "甲😀乙".repeat(15000) + "TAIL-END";
  const longXml = original.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    "<w:body><w:p><w:r><w:t>" + longText + "</w:t></w:r></w:p></w:body>",
  );
  current = changed(simple, longXml, "long-unicode");
  render();
  await until(() => text().includes("长段落分段显示"));
  let joined = "";
  for (let i = 0; i < 3; i++) {
    const p = document.querySelector(".document-paragraph > p:last-child")!;
    joined += p.textContent;
    const next = button("下一部分");
    if (!next || next.disabled) break;
    next.click();
    await pause();
  }
  check(
    "Unicode paragraph slices reconstruct exact text without broken surrogate",
    joined === longText && !/\uFFFD/.test(joined),
    { length: joined.length },
  );
  check(
    "long text contained by preview",
    document.querySelector("#app")!.getBoundingClientRect().right <= 1000 &&
      document.documentElement.scrollWidth <= 1000,
  );
  current = captures["docx-fixtures/06-png-pixels-invalid"];
  render();
  await until(() => !!document.querySelector('[role="alert"]'));
  check(
    "bad decoded image refuses ready body",
    !document.querySelector(".document-surface") &&
      !text().includes("invalid filter"),
  );
  mount.unmount();
  await pause();
  check("all created image URLs revoked", blobUrls.size === 0, blobUrls.size);
  check(
    "all workers terminated",
    workers.every((w) => w.closed),
    workers.length,
  );
  check(
    "only authorized DOCX capture IPC",
    calls.every((c) => c.command === "file_delivery_read_docx"),
  );
  document.querySelector("#result")!.textContent = JSON.stringify({
    passed: true,
    checks: results,
    calls,
    scope:
      "React StrictMode production DOCX UI, real Chromium Worker and codecs, controlled IPC captures. Not installed app.",
  });
} catch (error) {
  document.querySelector("#result")!.textContent = JSON.stringify({
    passed: false,
    checks: results,
    calls,
    error: String(error),
    stack: (error as Error).stack,
  });
} finally {
  document.documentElement.dataset.done = "true";
}
