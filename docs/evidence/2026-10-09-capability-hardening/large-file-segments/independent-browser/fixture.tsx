import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { OpenedFileView } from "/src/components/OpenedFileView";
import { FILE_OPEN_STRINGS as S } from "/src/runtime/file_open_strings";
import { TEXT_BLOCK_STRINGS as T } from "/src/runtime/text_block_strings";
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
const started = performance.now();
const checks: any[] = [],
  calls: any[] = [],
  unexpected: string[] = [],
  unhandled: string[] = [];
const B = 128 * 1024;
let scenario = "",
  version = 1,
  active = true,
  hold = false,
  failure: string | null = null;
let inspectFails = false;
let pending: {
  value: any;
  resolve: (v: any) => void;
  reject: (v: any) => void;
} | null = null;
const pause = (ms = 25) => new Promise((r) => setTimeout(r, ms));
window.addEventListener("unhandledrejection", (event) => {
  unhandled.push(String(event.reason?.code ?? event.reason));
});
function file(v = version) {
  return {
    root: "/controlled",
    path: `/controlled/${scenario}.md`,
    resolvedPath: `/controlled/${scenario}.md`,
    name: `${scenario}.md`,
    size: v === 2 ? B * 8 + 7 : B * 10 + 10,
    version: `v${v}`,
    sha256: `synthetic-${scenario}-${v}`,
  };
}
function body(f: any) {
  const letter = f.version === "v1" ? "A" : f.version === "v2" ? "B" : "C";
  const head = `# ${f.name} ${f.version}\n<script>controlled_not_executed</script>\n`;
  return head + letter.repeat(f.size - head.length);
}
function block(f: any, index: number, restore: boolean) {
  const all = body(f),
    count = Math.ceil(all.length / B);
  const actual = restore ? Math.min(index, count - 1) : index;
  if (actual >= count) throw { code: "invalidBlock" };
  const byteStart = actual * B,
    byteEnd = Math.min(byteStart + B, all.length);
  const text = all.slice(byteStart, byteEnd),
    prefix = all.slice(0, byteStart);
  const startLine = 1 + (prefix.match(/\n/g)?.length ?? 0);
  return {
    file: f,
    blockIndex: actual,
    blockCount: count,
    byteStart,
    byteEnd,
    startLine,
    endLine:
      startLine +
      (text.match(/\n/g)?.length ?? 0) -
      (text.endsWith("\n") ? 1 : 0),
    startsMidLine: actual > 0 && !prefix.endsWith("\n"),
    endsMidLine: actual < count - 1 && !text.endsWith("\n"),
    text,
  };
}
(globalThis as any).fixture = {
  invoke: async (cmd: string, args: any) => {
    calls.push({
      scenario,
      cmd,
      fileVersion: args?.file?.version,
      index: args?.blockIndex,
      restore: args?.restorePosition,
      atMs: Math.round(performance.now() - started),
    });
    if (
      cmd === "file_delivery_inspect_selected" ||
      cmd === "file_delivery_inspect"
    ) {
      if (inspectFails) throw new Error("controlled oversized file");
      return file();
    }
    if (cmd === "file_delivery_check_revision")
      return args.file.version === `v${version}` && args.mode === "hint"
        ? { kind: "hintUnchanged" }
        : { kind: "verified", file: file() };
    if (cmd === "file_delivery_read_text_block") {
      if (failure) throw { code: failure };
      const value = block(args.file, args.blockIndex, args.restorePosition);
      if (hold)
        return new Promise((resolve, reject) => {
          pending = { value, resolve, reject };
        });
      return value;
    }
    if (
      cmd === "file_delivery_open_selected_location" ||
      cmd === "file_delivery_reveal_selected_location"
    )
      return;
    unexpected.push(cmd);
    throw new Error("Unexpected IPC " + cmd);
  },
};
const appText = () => document.querySelector("#app")?.textContent ?? "";
const shown = () =>
  document.querySelector("#app .text-block-content")?.textContent ?? "";
const count = (cmd: string) =>
  calls.filter((c) => c.scenario === scenario && c.cmd === cmd).length;
async function until(fn: () => unknown, limit = 8000) {
  const start = performance.now();
  while (!fn()) {
    if (performance.now() - start > limit)
      throw new Error("timeout " + scenario + ": " + appText().slice(0, 1200));
    await pause();
  }
}
function check(name: string, ok: unknown, detail?: unknown) {
  checks.push({
    scenario,
    name,
    ok: Boolean(ok),
    elapsedMs: Math.round(performance.now() - started),
    detail,
  });
  if (!ok) throw new Error(name);
}
function mount() {
  flushSync(() =>
    root.render(
      <StrictMode>
        <OpenedFileView
          key={scenario}
          threadKey={`p17-${scenario}`}
          selectionKey={scenario}
          path={file().path}
          workingDirectory="/controlled"
          active={active}
          onOpenHtml={() => unexpected.push("html-handoff")}
        />
      </StrictMode>,
    ),
  );
}
async function select(name: string) {
  flushSync(() => root.render(null));
  await pause();
  scenario = name;
  version = 1;
  active = true;
  hold = false;
  pending = null;
  failure = null;
  inspectFails = false;
  document.querySelector("#stage")!.textContent = scenario;
  mount();
  await until(() => shown() === block(file(), 0, false).text);
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("#app button")].find(
    (b) => b.textContent?.trim() === label,
  );
}
function click(label: string) {
  const b = button(label);
  if (!b || b.disabled) throw new Error("unavailable button " + label);
  flushSync(() => b.click());
}
function release() {
  if (!pending) throw new Error("no pending read");
  const saved = pending;
  pending = null;
  hold = false;
  saved.resolve(saved.value);
}
async function screenshot(name: string) {
  document.documentElement.dataset.capture = name;
  await until(() => document.documentElement.dataset.captured === name);
}
async function run() {
  await select("navigation");
  check(
    "large Markdown is exact bounded source text rather than rendered partial Markdown",
    shown().length === B &&
      shown().startsWith("# navigation.md") &&
      !document.querySelector("#app .text-block-preview h1") &&
      !document.querySelector("#app .text-block-preview script"),
  );
  hold = true;
  click(T.next);
  await until(() => pending !== null);
  const old = shown(),
    reads = count("file_delivery_read_text_block"),
    revisions = count("file_delivery_check_revision");
  window.dispatchEvent(new Event("focus"));
  await pause(150);
  check(
    "navigation keeps old block and gates revision work while native receipt is pending",
    shown() === old &&
      count("file_delivery_read_text_block") === reads &&
      count("file_delivery_check_revision") === revisions,
  );
  click(T.cancel);
  release();
  await until(() => appText().includes(T.paused));
  check(
    "cancelled late successful block never replaces displayed block",
    shown() === old,
  );
  await until(() => button(T.retry) && !button(T.retry)!.disabled);
  click(T.retry);
  await until(() => appText().includes("第 2 /"));
  check(
    "explicit retry publishes next block with continuation and global line range",
    shown() === block(file(), 1, false).text &&
      appText().includes("开头承接上一片段") &&
      appText().includes("第 2 / 11 片段"),
  );
  await screenshot("bounded-source-navigation");
  hold = true;
  click(T.next);
  await until(() => pending !== null);
  active = false;
  mount();
  release();
  await pause();
  active = true;
  mount();
  await pause(100);
  check(
    "hide and reopen retain old block after a late navigation receipt",
    appText().includes("第 2 /") && shown() === block(file(), 1, false).text,
  );
  version = 2;
  hold = true;
  click(S.refresh);
  await until(() => pending !== null);
  check(
    "manual reread stages a new complete receipt without erasing old content",
    shown() === block(file(1), 1, false).text,
  );
  release();
  await until(() => shown() === block(file(2), 1, false).text);
  check(
    "manual reread publishes the new verified version and preserves reading position",
    appText().includes("第 2 /") && appText().includes("第 2 / 9 片段"),
  );
  hold = true;
  click(T.next);
  await until(() => pending !== null);
  const oldPending = pending!;
  await select("replacement");
  oldPending.resolve(oldPending.value);
  await pause(100);
  check(
    "a late old-file read cannot publish into a new selected file",
    shown().startsWith("# replacement.md v1") && appText().includes("第 1 /"),
  );
  await select("manual-pending");
  failure = "pending";
  click(S.refresh);
  await until(() => appText().includes(T.failures.pending));
  const pendingReads = count("file_delivery_read_text_block"),
    pendingChecks = count("file_delivery_check_revision");
  window.dispatchEvent(new Event("focus"));
  await pause(5250);
  check(
    "manual readPending retains old block and halts automatic reads and checks",
    shown() === block(file(1), 0, false).text &&
      count("file_delivery_read_text_block") === pendingReads &&
      count("file_delivery_check_revision") === pendingChecks,
    {
      pendingReads,
      pendingChecks,
      afterReads: count("file_delivery_read_text_block"),
      afterChecks: count("file_delivery_check_revision"),
    },
  );
  check(
    "manual readPending has no unhandled promise rejection",
    unhandled.length === 0,
    unhandled,
  );
  await screenshot("manual-pending-retained");
  check(
    "no small-text/full-file/Agent/open/save IPC substituted for block reads",
    unexpected.length === 0,
    unexpected,
  );
}
async function runPausedFlight() {
  for (const mode of ["cancel", "hide"]) {
    await select(`paused-flight-${mode}`);
    hold = true;
    click(T.next);
    await until(() => pending !== null);
    const original = pending!;
    const before = count("file_delivery_read_text_block");
    if (mode === "cancel") click(T.cancel);
    else {
      active = false;
      mount();
      active = true;
      mount();
    }
    if (button(S.refresh) && !button(S.refresh)!.disabled) click(S.refresh);
    await pause(150);
    const after = count("file_delivery_read_text_block");
    checks.push({
      scenario,
      name: "paused presentation must not admit an overlapping whole-file read",
      ok: after === before,
      detail: { mode, before, after, firstPromiseStillUnsettled: true },
    });
    const latest = pending;
    hold = false;
    pending = null;
    original.resolve(original.value);
    if (latest && latest !== original) latest.resolve(latest.value);
    await pause(50);
  }
}
async function runFallback() {
  scenario = "unverified-location";
  inspectFails = true;
  mount();
  await until(
    () => Boolean(button(T.openLocation)) && Boolean(button(T.revealLocation)),
  );
  await pause(100);
  check(
    "failed inspection exposes an explicit location fallback without auto-opening",
    count("file_delivery_open_selected_location") === 0 &&
      count("file_delivery_reveal_selected_location") === 0 &&
      count("file_delivery_read_text_block") === 0 &&
      appText().includes(T.locationScope),
  );
  click(T.openLocation);
  await until(() => appText().includes(T.openedLocation));
  check(
    "explicit open requests only the selected location without inventing a verified file",
    count("file_delivery_open_selected_location") === 1 &&
      shown() === "" &&
      !appText().includes(T.range(block(file(), 0, false))),
  );
  click(T.revealLocation);
  await until(() => appText().includes(T.revealedLocation));
  check(
    "explicit reveal remains distinct from content verification",
    count("file_delivery_reveal_selected_location") === 1 &&
      count("file_delivery_inspect_selected") === 2 &&
      count("file_delivery_read_text_block") === 0,
  );
  await screenshot("unverified-location-fallback");
}
try {
  if (new URLSearchParams(location.search).get("case") === "fallback")
    await runFallback();
  else if (new URLSearchParams(location.search).get("case") === "paused-flight")
    await runPausedFlight();
  else await run();
} catch (error) {
  checks.push({
    scenario,
    name: "sequence failure",
    ok: false,
    error: String(error),
  });
} finally {
  const result = {
    passed: checks.every((c) => c.ok),
    checks,
    calls,
    unexpected,
    unhandled,
    realElapsedMs: Math.round(performance.now() - started),
    boundary:
      "Actual Chromium StrictMode parent component and real text-block DTO parser. Controlled IPC; no native OS read or Agent call. Unmodified clock and timers.",
  };
  document.querySelector("#result")!.textContent = JSON.stringify(
    result,
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
