import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WorkbookFilePreview } from "/src/components/WorkbookFilePreview";
import {
  workbookFixture,
  replacePart,
  xmlBase64,
  fixtureStyles,
} from "/src/runtime/xlsx_fixture";
import "/src/styles.css";
import "/src/styles-content.css";
import "/src/product-shell.css";
const root = createRoot(document.querySelector("#app")!);
document
  .querySelector("#app")!
  .setAttribute(
    "style",
    "max-width:940px;margin:24px auto;padding:20px;background:var(--bg,#fff)",
  );
const results: any[] = [],
  calls: any[] = [],
  pending: any[] = [];
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
let defer = false;
const pause = () =>
  new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 20)));
async function until(read: () => unknown) {
  for (let i = 0; i < 180; i++) {
    if (read()) return;
    await pause();
  }
  throw Error(
    "UI wait expired: " +
      document.querySelector("#app")!.textContent?.slice(0, 700),
  );
}
function check(name: string, ok: unknown, detail?: unknown) {
  results.push({ name, ok: Boolean(ok), detail });
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (x) => x.textContent?.trim() === text,
  );
}
async function click(text: string) {
  const b = button(text);
  if (!b || b.disabled) throw Error("button unavailable: " + text);
  flushSync(() => b.click());
  await pause();
}
async function capture(label: string) {
  document.documentElement.dataset.capture = label;
  await until(() => document.documentElement.dataset.captured === label);
}
function makeFile(version: string) {
  return {
    root: "/controlled",
    path: "/controlled/example.xlsx",
    resolvedPath: "/controlled/example.xlsx",
    name: "example.xlsx",
    size: 123,
    sha256: version.padEnd(64, "a"),
    version,
  };
}
const file = makeFile("v1");
function data(forFile: any) {
  let input = workbookFixture(
    `<row r="1"><c r="A1"><v>0</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="str"><f>IF(1,"","")</f><v></v></c><c r="D1"><f>1+1</f></c><c r="E1" s="3"><v>60</v></c><c r="F1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="G1"><f t="shared" si="0"/><v>7</v></c></row>
 <row r="2"><c r="A2" t="inlineStr"><is><t>合并单元格</t></is></c><c r="D2" t="inlineStr"><is><t>${forFile.version}</t></is></c></row>
 <row r="5" hidden="1"><c r="A5" t="inlineStr"><is><t>HIDDEN_ANCHOR_VALUE</t></is></c></row>
 <row r="8" s="6" customFormat="1"/><row r="90"><c r="A90" t="inlineStr"><is><t>跨窗口合并内容</t></is></c></row>
 <row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>最后合法位置</t></is></c></row>`,
    {
      before:
        '<cols><col min="3" max="3" width="18"/><col min="8" max="8" hidden="1"/><col min="10" max="10" style="5"/></cols>',
      extra:
        '<mergeCells><mergeCell ref="A2:B3"/><mergeCell ref="A5:B6"/><mergeCell ref="A90:B110"/></mergeCells>',
      styles: fixtureStyles
        .replace('fills count="1"', 'fills count="3"')
        .replace(
          "</fills>",
          '<fill><patternFill patternType="solid"><fgColor rgb="FF22AA44"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDD4466"/></patternFill></fill></fills>',
        )
        .replace('cellXfs count="5"', 'cellXfs count="7"')
        .replace(
          "</cellXfs>",
          '<xf numFmtId="0" fontId="0" fillId="1" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0"/></cellXfs>',
        ),
    },
  );
  input = replacePart(input, "xl/workbook.xml", (s) =>
    s.replace(
      "</sheets>",
      '<sheet name="隐藏表" sheetId="2" r:id="sheet2" state="hidden"/></sheets>',
    ),
  );
  input = replacePart(input, "xl/_rels/workbook.xml.rels", (s) =>
    s.replace(
      "</Relationships>",
      `<Relationship Id="sheet2" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    ),
  );
  input.parts.push({
    name: "xl/worksheets/sheet2.xml",
    data: xmlBase64(
      `<worksheet xmlns="${NS}"><sheetData><row><c r="A1" t="inlineStr"><is><t>第二表内容</t></is></c></row></sheetData></worksheet>`,
    ),
  });
  input.entries.push("xl/worksheets/sheet2.xml");
  return { ...input, file: forFile, inflatedBytes: 40000 };
}
(window as any).__TAURI_INTERNALS__ = {
  invoke(command: string, args: any) {
    calls.push({ command, version: args?.file?.version });
    if (command !== "file_delivery_read_workbook")
      throw Error("unexpected IPC: " + command);
    const value = data(args.file);
    return defer
      ? new Promise((resolve) => pending.push({ resolve, value }))
      : Promise.resolve(value);
  },
};
function render(f = file, active = true, key = f.version) {
  flushSync(() =>
    root.render(
      <StrictMode>
        <WorkbookFilePreview key={key} file={f} active={active} />
      </StrictMode>,
    ),
  );
}
const cell = (address: string) =>
  document.querySelector<HTMLButtonElement>(`[data-cell="${address}"] button`);
const detail = () => document.querySelector('[aria-label="单元格内容"]');
async function choose(address: string) {
  const c = cell(address);
  if (!c) throw Error("cell unavailable: " + address);
  flushSync(() => c.click());
  await pause();
  return detail()!.textContent!;
}
async function jump(value: string) {
  const el = document.querySelector<HTMLInputElement>(
    'input[aria-label="单元格位置"]',
  )!;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(el, value);
  flushSync(() => el.dispatchEvent(new Event("input", { bubbles: true })));
  await click("前往");
}
async function sheet(value: string) {
  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="工作表"]',
  )!;
  flushSync(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(
    () =>
      document.querySelector("table caption")?.textContent ===
      (value === "sheet2" ? "隐藏表" : "样本"),
  );
}
try {
  render();
  await until(() => cell("A1"));
  check("actual Worker and StrictMode UI ready", !!cell("A1"), {
    calls: calls.length,
  });
  check(
    "numeric zero preserved",
    cell("A1")!.textContent === "0",
    await choose("A1"),
  );
  check(
    "false remains false",
    cell("B1")!.textContent === "FALSE" &&
      (await choose("B1")).includes("false"),
    cell("B1")!.textContent,
  );
  const empty = await choose("C1");
  check(
    "cached empty string distinguished from missing cache",
    empty.includes("空文本") &&
      empty.includes('IF(1,"","")') &&
      !empty.includes("未保存计算结果"),
    empty,
  );
  const absent = await choose("D1");
  check(
    "missing formula cache is explicit",
    absent.includes("未保存计算结果") && absent.includes("1+1"),
    absent,
  );
  const date = await choose("E1");
  check(
    "1900 date serial 60 formatted and raw retained",
    date.includes("1900-02-29") && date.includes("60"),
    date,
  );
  const err = await choose("F1");
  check(
    "cached formula error is retained",
    err.includes("#DIV/0!") && err.includes("1/0"),
    err,
  );
  const shared = await choose("G1");
  check(
    "absent shared-formula body is explicit",
    shared.includes("文件未保存此单元格的完整公式文本"),
    shared,
  );
  await click("收起单元格内容");
  check(
    "merge retains actual spans",
    document.querySelector('[data-cell="A2"]')?.getAttribute("colspan") ===
      "2" &&
      document.querySelector('[data-cell="A2"]')?.getAttribute("rowspan") ===
        "2",
  );
  check(
    "hidden row/column and hidden merge source never leak",
    !document.querySelector('[data-cell="A5"]') &&
      !document.querySelector('[data-cell="H1"]') &&
      !document
        .querySelector("#app")!
        .textContent?.includes("HIDDEN_ANCHOR_VALUE"),
  );
  check(
    "blank cells inherit column and row styles",
    getComputedStyle(document.querySelector('[data-cell="J7"]')!)
      .backgroundColor === "rgb(34, 170, 68)" &&
      getComputedStyle(document.querySelector('[data-cell="J8"]')!)
        .backgroundColor === "rgb(221, 68, 102)",
    {
      column: getComputedStyle(document.querySelector('[data-cell="J7"]')!)
        .backgroundColor,
      row: getComputedStyle(document.querySelector('[data-cell="J8"]')!)
        .backgroundColor,
    },
  );
  await capture("ui-values-merged");
  const toggle = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  flushSync(() => toggle.click());
  await pause();
  check(
    "explicit reveal restores hidden anchor and column",
    cell("A5")?.textContent === "HIDDEN_ANCHOR_VALUE" && !!cell("H1"),
  );
  await choose("A5");
  flushSync(() => toggle.click());
  await pause();
  check(
    "hiding clears selected hidden detail",
    !detail() &&
      !document
        .querySelector("#app")!
        .textContent?.includes("HIDDEN_ANCHOR_VALUE"),
  );
  await click("下一组行");
  check(
    "row paging starts at 101 and merge continuation explicit",
    !!cell("A101") &&
      cell("A101")!.title.includes("跨越当前显示范围") &&
      cell("A101")!.textContent!.includes("跨窗口合并内容"),
    cell("A101")?.title,
  );
  check(
    "each rendered window stays bounded",
    document.querySelectorAll("[data-cell]").length <= 2400,
    { cells: document.querySelectorAll("[data-cell]").length },
  );
  await jump("XFD1048576");
  check(
    "far legal sparse cell does not allocate preceding cells",
    cell("XFD1048576")?.textContent === "最后合法位置" &&
      document.querySelectorAll("[data-cell]").length === 1,
    { cells: document.querySelectorAll("[data-cell]").length },
  );
  await jump("XFE1048576");
  check(
    "invalid address keeps current grid with error",
    document
      .querySelector('input[aria-label="单元格位置"]')
      ?.getAttribute("aria-invalid") === "true" && !!cell("XFD1048576"),
  );
  const callCount = calls.length;
  await sheet("sheet2");
  check(
    "sheet selection uses same captured file and labels hidden sheet",
    cell("A1")?.textContent === "第二表内容" &&
      calls.length === callCount &&
      document.querySelector("select")?.textContent?.includes("隐藏表 · 隐藏"),
    { callsBefore: callCount, callsAfter: calls.length },
  );
  await capture("ui-hidden-sheet");
  await sheet("sheet1");
  check(
    "returning sheet resets grid/selection safely",
    !!cell("A1") && !detail(),
  );
  // Delayed capture boundary: cancellation and version replacement use actual UI/worker.
  defer = true;
  const slow = makeFile("slow");
  render(slow);
  await until(() => button("取消预览"));
  await click("取消预览");
  for (const p of pending.splice(0)) p.resolve(p.value);
  await pause();
  check(
    "cancelled capture cannot become ready late",
    !document.querySelector("table") &&
      document.querySelector("#app")!.textContent?.includes("已取消本次预览"),
  );
  defer = false;
  await click("重新预览");
  await until(() => cell("D2")?.textContent === "slow");
  check(
    "retry after cancellation reads and renders safely",
    cell("D2")!.textContent === "slow",
  );
  defer = true;
  const old = makeFile("old");
  render(old);
  await until(() => pending.length > 0);
  render(old, false);
  for (const p of pending.splice(0)) p.resolve(p.value);
  await pause();
  check(
    "hidden owner cannot publish late capture",
    !document.querySelector("table"),
  );
  defer = false;
  render(old, true);
  await until(() => cell("D2")?.textContent === "old");
  defer = true;
  const stale = makeFile("stale");
  render(stale);
  await until(() => pending.length > 0);
  const oldPending = pending.splice(0);
  defer = false;
  const latest = makeFile("latest");
  render(latest);
  await until(() => cell("D2")?.textContent === "latest");
  oldPending.forEach((p) => p.resolve(p.value));
  await pause();
  check(
    "old version response never overwrites new version",
    cell("D2")?.textContent === "latest",
  );
  await choose("D2");
  await capture("ui-new-version");
  check(
    "only bounded file capture IPC invoked",
    calls.every((c) => c.command === "file_delivery_read_workbook"),
    { calls: calls.length },
  );
} catch (error) {
  results.push({ name: "fixture completion", ok: false, error: String(error) });
}
document.querySelector("#result")!.textContent = JSON.stringify(
  {
    passed: results.every((r) => r.ok),
    results,
    calls,
    scope:
      "Real Chromium, React StrictMode WorkbookFilePreview, production XLSX Worker. Authored XML capture via strict IPC fixture; no native app/real file/Agent; not WebKit acceptance.",
  },
  null,
  2,
);
document.documentElement.dataset.done = "true";
