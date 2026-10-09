import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { OpenedFileView } from "/src/components/OpenedFileView";
import { TextBlockPreview } from "/src/components/TextBlockPreview";
import { SourceTextSelection } from "/src/components/SourceTextSelection";
import {
  createTextFeedbackSource,
  textFeedbackRange,
  textFeedbackRangeMatches,
} from "/src/runtime/text_feedback_range";
import {
  fileFeedbackDrafts,
  fileFeedbackKey,
  composerDrafts,
  draftQueues,
  parseDraftSnapshot,
} from "/src/runtime/drafts";
import { draftPersistence } from "/src/runtime/draft_storage";
import { fileFeedbackText } from "/src/runtime/feedback_strings";
import { FILE_OPEN_STRINGS as O } from "/src/runtime/file_open_strings";
import { SOURCE_TEXT_SELECTION_STRINGS as S } from "/src/runtime/source_text_selection_strings";
import { TEXT_BLOCK_STRINGS as B } from "/src/runtime/text_block_strings";
import { WORKSPACE_STRINGS as W } from "/src/runtime/workspace_strings";
import "/src/styles.css";
import "/src/styles-artifact.css";
import "/src/styles-settings.css";
import "/src/styles-content.css";
import "/src/styles-thread.css";
import "/src/product-shell.css";
import "/src/conversation-workspace.css";
import "/src/history-import.css";
import "/src/desktop-workbench.css";

const root = createRoot(document.querySelector("#app")!);
const mode = new URLSearchParams(location.search).get("case") || "parent";
const checks: any[] = [],
  calls: any[] = [],
  unexpected: string[] = [],
  unhandled: string[] = [];
const domEvents: any[] = [];
for (const type of ["click", "keydown", "keyup", "focusin", "focusout"])
  document.addEventListener(
    type,
    (e) =>
      domEvents.push({
        type,
        target: (e.target as HTMLElement)?.textContent?.slice(0, 90),
        key: (e as KeyboardEvent).key,
        active: document.activeElement?.textContent?.slice(0, 90),
      }),
    true,
  );
const confirmations: any[] = [],
  availability: any[] = [];
const base = "/docs/evidence/2026-10-09-capability-hardening/";
const wire = await fetch(
  base + "large-file-segments/text-block-wire.json",
).then((r) => r.json());
const oracle = await fetch("./wire-oracle.json").then((r) => r.json());
const smallOracle = await fetch("../coordinate-oracles.json").then((r) =>
  r.json(),
);
const smallText = smallOracle.small.text + "repeat repeat\n";
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const clone = (v: any) => structuredClone(v);
const equal = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
let scenario = "",
  revision = 1,
  active = true,
  path = "sample.txt",
  thread = "p21-independent",
  selectionKey = "first";
let currentText = smallText,
  readFailure: any = null,
  holdRead = false,
  pending: any = null,
  saveFailure = false;
let savedRaw: any = null,
  initialRaw: any = null;
const contentId = (f: any) =>
  `disk:${JSON.stringify([f.resolvedPath, f.version, f.sha256])}`;
function file(v = revision, text = currentText) {
  return {
    root: "/controlled",
    path: "/controlled/" + path,
    resolvedPath: "/controlled/" + path,
    name: path,
    size: new TextEncoder().encode(text).length,
    sha256: (v === 1 ? "a" : "b").repeat(64),
    version: `controlled-${v}`,
  };
}
const app = () => document.querySelector("#app")!;
const text = () => app().textContent ?? "";
const pre = () =>
  app().querySelector<HTMLPreElement>('pre[aria-label="' + S.source + '"]')!;
const buttons = () => [...app().querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) =>
  buttons().find((b) => b.textContent === label)!;
const saved = (f = file()) =>
  fileFeedbackDrafts.read(thread, f.resolvedPath, contentId(f));
function check(id: string, name: string, ok: unknown, detail?: unknown) {
  checks.push({ scenario, id, name, ok: !!ok, detail });
  if (!ok) throw new Error(name);
}
async function until(fn: () => unknown, ms = 6000) {
  const start = performance.now();
  while (!fn()) {
    if (performance.now() - start > ms)
      throw new Error("Timeout " + scenario + " " + text().slice(0, 600));
    await pause();
  }
}
function input(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    node.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
function click(label: string) {
  const b = button(label);
  if (!b || b.disabled) throw new Error("Unavailable button " + label);
  b.click();
}
let actionId = 0;
async function realAction(value: any) {
  const id = ++actionId;
  (window as any).browserAction = { id, ...value };
  await until(() => (window as any).browserActionDone === id);
  delete (window as any).browserAction;
}
async function capture(label: string) {
  document.documentElement.dataset.capture = label;
  await until(() => document.documentElement.dataset.captured === label);
  delete document.documentElement.dataset.capture;
}
function offsets(start: number, end: number, reverse = false) {
  const node = pre().firstChild!;
  pre().focus();
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.setBaseAndExtent(
    node,
    reverse ? end : start,
    node,
    reverse ? start : end,
  );
  document.dispatchEvent(new Event("selectionchange"));
}
async function select(start: number, end: number, reverse = false) {
  offsets(start, end, reverse);
  await until(() => !!button(S.confirm) && !button(S.confirm).disabled);
}
async function confirm() {
  button(S.confirm).focus();
  await realAction({ kind: "enter" });
  await pause();
  domEvents.push({
    type: "afterConfirm",
    saved: saved(),
    entries: fileFeedbackDrafts.entries(thread),
    buttonDisabled: button(S.confirm)?.disabled,
    body: text().slice(-800),
  });
}
function mount() {
  flushSync(() =>
    root.render(
      <StrictMode>
        <OpenedFileView
          threadKey={thread}
          selectionKey={selectionKey}
          path={path}
          workingDirectory="/controlled"
          active={active}
          onOpenHtml={() => unexpected.push("HTML")}
        />
      </StrictMode>,
    ),
  );
}
async function newParent(name: string, markdown = false) {
  scenario = name;
  revision = 1;
  active = true;
  selectionKey = name;
  path = markdown ? `${name}.md` : `${name}.txt`;
  currentText = markdown ? "# 标题\r\n**repeat** repeat\n" : smallText;
  readFailure = null;
  holdRead = false;
  pending = null;
  mount();
  await until(() => !!button(O.open));
  if (markdown) {
    check(
      "TF07",
      "rendered Markdown has no source selection",
      !pre() && !!app().querySelector("h1"),
    );
    click(O.markdownSource);
  }
  await until(() => !!pre());
}
(window as any).fixture = {
  invoke: async (cmd: string, args: any) => {
    calls.push({
      scenario,
      cmd,
      fileVersion: args?.file?.version,
      index: args?.blockIndex,
    });
    if (cmd === "settings_get") return clone(initialRaw);
    if (cmd === "settings_set") {
      if (saveFailure) throw "controlled save failure";
      savedRaw = clone(args.value);
      return;
    }
    if (
      cmd === "file_delivery_inspect" ||
      cmd === "file_delivery_inspect_selected"
    )
      return file();
    if (cmd === "file_delivery_read_text") {
      if (readFailure) throw readFailure;
      const result = { file: args.file, text: currentText };
      if (holdRead)
        return new Promise((resolve, reject) => {
          pending = { resolve, reject, result };
        });
      return result;
    }
    if (cmd === "file_delivery_check_revision")
      return args.file.version === file().version
        ? { kind: "hintUnchanged" }
        : { kind: "verified", file: file() };
    if (cmd === "file_delivery_read_text_block") {
      if (readFailure) throw readFailure;
      const result = wire[args.blockIndex];
      if (holdRead)
        return new Promise((resolve, reject) => {
          pending = { resolve, reject, result };
        });
      return clone(result);
    }
    unexpected.push(cmd);
    throw new Error("Unexpected IPC " + cmd);
  },
};
window.addEventListener("unhandledrejection", (e) =>
  unhandled.push(String(e.reason)),
);

async function coordinates() {
  scenario = "wire-oracles";
  for (const expected of oracle.cases) {
    const raw = wire[expected.block],
      source = createTextFeedbackSource(raw, raw.file)!;
    const actual = textFeedbackRange(
      source,
      expected.localUtf16Start,
      expected.localUtf16End,
    );
    const want = {
      kind: "text-range",
      byteStart: expected.byteStart,
      byteEnd: expected.byteEnd,
      startLine: expected.startLine,
      endLine: expected.endLine,
    };
    check(
      "TF03/04",
      "real Rust wire offsets " +
        expected.block +
        ":" +
        expected.localUtf16Start,
      equal(actual, want),
      { actual, want },
    );
  }
  const data = smallOracle.small;
  const f = { ...file(1, data.text), size: data.utf8Bytes };
  const source = createTextFeedbackSource({ file: f, text: data.text }, f)!;
  for (const expected of data.cases) {
    const actual = textFeedbackRange(
      source,
      expected.utf16Start,
      expected.utf16End,
    );
    check(
      "TF01/03",
      "Unicode/BOM/CRLF exact bytes " + expected.utf16Start,
      equal(actual, {
        kind: "text-range",
        byteStart: expected.byteStart,
        byteEnd: expected.byteEnd,
        startLine: expected.startLine,
        endLine: expected.endLine,
      }),
      actual,
    );
  }
  for (const bad of data.invalidEndpoints)
    check(
      "TF02",
      "reject split endpoint " + bad.utf16,
      textFeedbackRange(source, 0, bad.utf16) === null,
    );
  check(
    "TF02",
    "reverse offsets retain range",
    equal(textFeedbackRange(source, 9, 4), textFeedbackRange(source, 4, 9)),
  );
  check(
    "TF02/05",
    "empty, negative and beyond rejected",
    [
      textFeedbackRange(source, 0, 0),
      textFeedbackRange(source, -1, 2),
      textFeedbackRange(source, 0, 99),
    ].every((x) => x === null),
  );
  const raw = clone(source);
  check(
    "TF08",
    "manufactured source object is not live factory result",
    textFeedbackRange(raw, 0, 1) === null &&
      !textFeedbackRangeMatches(raw, {
        kind: "text-range",
        byteStart: 0,
        byteEnd: 3,
        startLine: 1,
        endLine: 1,
      }),
  );
  const a = textFeedbackRange(source, 4, 9)!;
  check(
    "TF08",
    "forged line numbers cannot revalidate",
    !textFeedbackRangeMatches(source, { ...a, startLine: 1 }),
  );
}
async function parent() {
  await draftPersistence.load();
  await newParent("unicode-parent");
  check(
    "TF06",
    "original CRLF/BOM text kept in DOM",
    pre().textContent === smallText,
  );
  await select(4, 9);
  check(
    "TF12",
    "selection alone does not save a target",
    saved().anchor === undefined,
  );
  await confirm();
  check(
    "TF01/06",
    "confirmed exact Unicode range",
    equal(saved().anchor, {
      kind: "text-range",
      byteStart: 6,
      byteEnd: 16,
      startLine: 2,
      endLine: 2,
    }),
    saved().anchor,
  );
  input(app().querySelector("textarea")!, "原意见保留");
  await pause();
  const first = clone(saved());
  const second = smallText.lastIndexOf("repeat");
  await select(second, second + 6, true);
  check(
    "TF12",
    "reverse new selection does not retarget existing opinion",
    equal(saved(), first),
  );
  await confirm();
  const expectedStart = new TextEncoder().encode(
    smallText.slice(0, second),
  ).length;
  check(
    "TF06/12",
    "second repeated text uses actual DOM position",
    saved().anchor.byteStart === expectedStart &&
      saved().anchor.byteEnd === expectedStart + 6 &&
      saved().text === "原意见保留",
    saved(),
  );
  await capture("p21-precise-text-target");
  // A real mouse drag, using glyph rectangles of the actual displayed source.
  await newParent("pointer-parent");
  const start = smallText.lastIndexOf("repeat"),
    end = start + 6;
  pre().scrollIntoView({ block: "center" });
  const node = pre().firstChild!;
  const a = document.createRange();
  a.setStart(node, start);
  a.setEnd(node, start + 1);
  const ar = a.getBoundingClientRect();
  const b = document.createRange();
  b.setStart(node, end - 1);
  b.setEnd(node, end);
  const br = b.getBoundingClientRect();
  await realAction({
    kind: "drag",
    from: { x: ar.left + 0.3, y: ar.top + ar.height / 2 },
    to: { x: br.right - 0.3, y: br.top + br.height / 2 },
  });
  await pause(300);
  domEvents.push({
    type: "afterDrag",
    selection: document.getSelection()?.toString(),
    rangeCount: document.getSelection()?.rangeCount,
    collapsed: document.getSelection()?.isCollapsed,
    start: document.getSelection()?.anchorOffset,
    end: document.getSelection()?.focusOffset,
    ar: ar.toJSON(),
    br: br.toJSON(),
    userSelect: getComputedStyle(pre()).userSelect,
  });
  await capture("p21-pointer-diagnostic");
  await until(() => !button(S.confirm).disabled);
  await confirm();
  check(
    "TF06",
    "real CDP mouse drag matches repeated-text byte target",
    saved().anchor?.byteStart === expectedStart &&
      saved().anchor?.byteEnd === expectedStart + 6,
    saved().anchor,
  );
  // Keyboard-visible line route builds a real Range and requires a second Enter.
  await newParent("keyboard-parent");
  const details = app().querySelector(
    ".source-text-selection details",
  ) as HTMLDetailsElement;
  details.open = true;
  const numbers = details.querySelectorAll<HTMLInputElement>(
    'input[type="number"]',
  );
  input(numbers[0], "2");
  input(numbers[1], "2");
  button(S.selectLines).focus();
  await realAction({ kind: "enter" });
  await until(() => document.activeElement === button(S.confirm));
  check(
    "TF06",
    "line keyboard stage requires explicit confirmation",
    saved().anchor === undefined,
  );
  await realAction({ kind: "enter" });
  await pause();
  check(
    "TF03/06",
    "keyboard selected current logical line with original CR",
    equal(saved().anchor, {
      kind: "text-range",
      byteStart: 6,
      byteEnd: 17,
      startLine: 2,
      endLine: 2,
    }),
    saved().anchor,
  );
  await newParent("invalid-dom");
  offsets(0, 6);
  await pause();
  check(
    "TF02",
    "half surrogate DOM selection cannot confirm",
    button(S.confirm).disabled,
  );
  offsets(0, 3);
  await pause();
  check(
    "TF02",
    "half CRLF DOM selection cannot confirm",
    button(S.confirm).disabled,
  );
  await select(4, 9);
  document.querySelector<HTMLButtonElement>("#outside")!.focus();
  await pause();
  check(
    "TF06/10",
    "focus outside retires candidate",
    button(S.confirm).disabled,
  );
  await select(4, 9);
  active = false;
  mount();
  await pause();
  check(
    "TF10",
    "hidden candidate cannot confirm",
    button(S.confirm).disabled && saved().anchor === undefined,
  );
  active = true;
  mount();
  await pause();
  check(
    "TF10",
    "reactivation does not resurrect selection",
    button(S.confirm).disabled,
  );
  await select(4, 9);
  selectionKey = "new-page-same-file";
  mount();
  await until(() => !!pre() && !button(S.confirm).disabled === false);
  check(
    "TF10",
    "new page identity retires old same-path candidate",
    button(S.confirm).disabled && saved().anchor === undefined,
  );
  await newParent("markdown-parent", true);
  check(
    "TF07",
    "source mode exact raw markdown",
    pre().textContent === currentText,
  );
  await select(2, 4);
  click(O.markdownRendered);
  await pause();
  check(
    "TF07/10",
    "rendered switch removes candidate and source",
    !pre() && saved().anchor === undefined,
  );
  click(O.markdownSource);
  await until(() => !!pre());
  check("TF07", "back to source starts unselected", button(S.confirm).disabled);
}
async function refresh() {
  await draftPersistence.load();
  await newParent("refresh-parent");
  const old = file();
  await select(4, 9);
  const beforeReads = calls.filter(
    (c) => c.cmd === "file_delivery_read_text",
  ).length;
  revision = 2;
  currentText = smallText.replace("repeat repeat", "new new");
  window.dispatchEvent(new Event("focus"));
  await until(() => text().includes(O.revisionNotices.newVersion));
  check(
    "TF10/12",
    "live candidate defers fresh version read",
    calls.filter((c) => c.cmd === "file_delivery_read_text").length ===
      beforeReads && pre().textContent === smallText,
  );
  document.querySelector<HTMLButtonElement>("#outside")!.focus();
  await pause();
  click(O.refresh);
  await until(() => pre()?.textContent === currentText, 8000);
  check(
    "TF10/16",
    "explicit reread after deferred notice loads next version",
    saved(old).anchor === undefined && button(S.confirm).disabled,
  );
  await select(4, 9);
  await confirm();
  input(app().querySelector("textarea")!, "保留旧版意见");
  await pause();
  const previous = clone(saved());
  const previousFile = file();
  revision = 3;
  currentText = "replacement\n";
  click(O.refresh);
  await until(() => pre()?.textContent === currentText);
  check(
    "TF12/13",
    "explicit reread retains old-version target",
    equal(saved(previousFile), previous) && saved().anchor === undefined,
  );
  check(
    "TF13",
    "old opinion remains reachable",
    text().includes("保留旧版意见") && text().includes("位置未重新核对"),
  );
}
async function block() {
  scenario = "actual-wire-block";
  const first = wire[0];
  let enabled = true;
  const mountBlock = () =>
    flushSync(() =>
      root.render(
        <StrictMode>
          <TextBlockPreview
            initial={first}
            active={enabled}
            onTextSelectionAvailability={(v) => availability.push(v)}
            onTextSelectionConfirm={(v) => confirmations.push(v)}
          />
        </StrictMode>,
      ),
    );
  mountBlock();
  await until(() => !!pre());
  await select(1, 3);
  await confirm();
  check(
    "TF03/06",
    "real wire first block includes BOM byte prefix",
    equal(confirmations.at(-1).anchor, {
      kind: "text-range",
      byteStart: 3,
      byteEnd: 9,
      startLine: 1,
      endLine: 1,
    }),
  );
  click(B.next);
  await until(() =>
    app().querySelector("[data-block-range]")?.textContent?.includes("2 / 3"),
  );
  await select(123, 126);
  await confirm();
  check(
    "TF04/11",
    "child current block global offset differs from initial block",
    equal(confirmations.at(-1).anchor, {
      kind: "text-range",
      byteStart: 131195,
      byteEnd: 131198,
      startLine: 2,
      endLine: 2,
    }),
  );
  check(
    "TF04",
    "long-line continuation has no invented column",
    text().includes("同一行") && !text().includes("第 1 列"),
  );
  await select(0, 3);
  holdRead = true;
  click(B.next);
  await until(() => pending);
  check(
    "TF10/16",
    "in-flight next read retires old candidate",
    button(S.confirm).disabled,
  );
  enabled = false;
  mountBlock();
  pending.resolve(pending.result);
  pending = null;
  holdRead = false;
  await pause();
  check(
    "TF10",
    "hidden late read does not revive confirmation",
    button(S.confirm).disabled,
  );
  enabled = true;
  mountBlock();
  await pause();
  check(
    "TF10",
    "reactivated block remains unselected",
    button(S.confirm).disabled,
  );
  await capture("p21-real-wire-block");
}
async function persistence() {
  await draftPersistence.load();
  await newParent("persistence-parent");
  await select(4, 9);
  await confirm();
  input(app().querySelector("textarea")!, "  保留意见空白\n下一行  ");
  await pause();
  const attachment = {
    id: "retained-file",
    kind: "file",
    name: "safe.txt",
    uri: "/controlled/safe.txt",
  };
  const original = {
    text: "已有输入",
    attachments: [attachment],
    sendPending: true,
    queueEdit: { index: 0, original: [{ type: "text", text: "旧待发" }] },
  };
  composerDrafts.update("session:" + thread, () => original);
  draftQueues.write(thread, [[{ type: "text", text: "保持暂停" }]], null);
  await draftPersistence.flush();
  const before = clone(savedRaw);
  const entry = clone(saved());
  const key = fileFeedbackKey(entry.path, entry.contentId);
  const otherThread = "other-independent";
  fileFeedbackDrafts.update(otherThread, "/controlled/other.txt", {
    text: "other",
    selection: null,
    scope: "file",
  });
  await draftPersistence.flush();
  click(W.feedbackAdd);
  await until(() => !fileFeedbackDrafts.entries(thread)[key]);
  await draftPersistence.flush();
  const next = composerDrafts.read("session:" + thread);
  check(
    "TF14",
    "take preserves original composer fields and appends exact opinion",
    next.text.startsWith(original.text + "\n\n") &&
      next.text.includes(entry.text) &&
      equal(next.attachments, original.attachments) &&
      next.sendPending === true &&
      equal(next.queueEdit, original.queueEdit),
  );
  check(
    "TF14",
    "take keeps other opinion and paused queue",
    fileFeedbackDrafts.entries(otherThread)[
      fileFeedbackKey("/controlled/other.txt")
    ]?.text === "other" &&
      equal(draftQueues.read(thread), {
        blocks: [[{ type: "text", text: "保持暂停" }]],
        uncertainIndex: null,
      }),
  );
  check(
    "TF14",
    "repeat exact take is harmless",
    !fileFeedbackDrafts.take(thread, key, fileFeedbackText(entry)) &&
      equal(composerDrafts.read("session:" + thread), next),
  );
  check(
    "TF08/13/17",
    "serialized opinion clearly historical and no whole source persisted",
    next.text.includes("位置未重新核对") &&
      next.text.includes(entry.contentId.slice(-66, -2)) &&
      !JSON.stringify(savedRaw).includes(smallText),
  );
  const invalid = [
    { ...entry.anchor, extra: true },
    { ...entry.anchor, kind: "unknown" },
    { ...entry.anchor, byteStart: "6" },
    { ...entry.anchor, byteEnd: 6 },
    { ...entry.anchor, startLine: 0 },
    { ...entry.anchor, page: 1 },
  ];
  for (const a of invalid) {
    const raw = clone(before);
    raw.feedback[thread][key].anchor = a;
    let threw = false;
    try {
      parseDraftSnapshot(raw);
    } catch {
      threw = true;
    }
    check(
      "TF09",
      "cold parser rejects malformed/unknown field " + JSON.stringify(a),
      threw,
    );
  }
  check(
    "TF09",
    "valid historical range parses without fresh read proof",
    !!parseDraftSnapshot(before),
  );
  // Save failure: final serialized disk object must keep the previous opinion.
  fileFeedbackDrafts.update(thread, entry.path, entry);
  await draftPersistence.flush();
  const oldDisk = clone(savedRaw);
  saveFailure = true;
  check(
    "TF15",
    "take accepted in memory before failed persistence",
    fileFeedbackDrafts.take(thread, key, fileFeedbackText(entry)),
  );
  await until(() => !!draftPersistence.snapshot().error);
  check(
    "TF15",
    "failed save retains original disk opinion and combined memory draft",
    equal(savedRaw, oldDisk) &&
      !!savedRaw.feedback[thread][key] &&
      composerDrafts.read("session:" + thread).text.includes(entry.text),
  );
  saveFailure = false;
}
try {
  if (mode === "coordinates") await coordinates();
  else if (mode === "parent") await parent();
  else if (mode === "refresh") await refresh();
  else if (mode === "block") await block();
  else if (mode === "persistence") await persistence();
  else throw new Error("Unknown mode");
  check(
    "all",
    "no prompt/permission/unexpected IPC or unhandled rejection",
    unexpected.length === 0 && unhandled.length === 0,
    { unexpected, unhandled },
  );
} catch (error) {
  checks.push({
    scenario,
    name: "scenario interrupted",
    ok: false,
    error: String(error),
  });
}
const result = {
  mode,
  passed: checks.every((c) => c.ok),
  checks,
  calls,
  domEvents,
  unexpected,
  unhandled,
  boundary:
    "Actual production React components/styles and DOM plus controlled Tauri invoke. Real Rust wire is preserved historical fixture, not live filesystem proof. Browser Enter/mouse are real CDP input; explicit Range construction used only separately labeled DOM-coordinate cases. No native app/Agent/OS opener.",
};
document.querySelector("#result")!.textContent = JSON.stringify(
  result,
  null,
  2,
);
document.documentElement.dataset.done = "true";
