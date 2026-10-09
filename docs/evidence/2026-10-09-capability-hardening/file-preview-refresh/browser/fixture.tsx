import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { OpenedFileView } from "/src/components/OpenedFileView";
import { fileFeedbackDrafts } from "/src/runtime/drafts";
import { FILE_OPEN_STRINGS as S } from "/src/runtime/file_open_strings";
import "/src/styles.css";
import "/src/styles-artifact.css";

const started = performance.now();
const root = createRoot(document.querySelector("#app")!);
const results: any[] = [],
  calls: any[] = [],
  unexpected: string[] = [];
const seeds = await (await fetch("./captures.json")).json();
let scenario = "",
  ext = "txt",
  diskVersion = 1,
  active = true;
let failure: string | null = null,
  invalid = false;
let captureHold = false,
  textHold = false;
let deferred: {
  resolve: (value?: any) => void;
  reject: (error: any) => void;
  value: any;
} | null = null;
const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => unknown, limit = 8500) {
  const start = performance.now();
  while (!fn()) {
    if (performance.now() - start > limit)
      throw new Error(
        "timeout: " +
          scenario +
          " " +
          document.querySelector("#app")?.textContent?.slice(0, 1800),
      );
    await pause();
  }
}
function check(name: string, ok: unknown, detail?: unknown) {
  results.push({
    scenario,
    name,
    ok: !!ok,
    elapsedMs: Math.round(performance.now() - started),
    detail,
  });
  if (!ok) throw new Error(name);
}
const file = (version = diskVersion) => ({
  root: "/controlled",
  path: `/controlled/${scenario}.${ext}`,
  resolvedPath: `/controlled/${scenario}.${ext}`,
  name: `${scenario}.${ext}`,
  size: 1024,
  version: `v${version}`,
  sha256: `synthetic-${version}`,
});
const marker = (version: string) => `P20-${ext}-${version}`;
function capture(f: any) {
  const value = structuredClone(seeds[ext]);
  value.file = f;
  const part = value.parts.find(
    (p: any) =>
      p.name ===
      (ext === "docx" ? "word/document.xml" : "xl/worksheets/sheet1.xml"),
  );
  let xml = new TextDecoder().decode(
    Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)),
  );
  if (invalid) xml = "<broken>";
  else if (ext === "docx")
    xml = xml.replace(
      /<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/,
      `<w:t>${marker(f.version)}</w:t>`,
    );
  else xml = xml.replace("Farfold authored fixture", marker(f.version));
  part.data = btoa(String.fromCharCode(...new TextEncoder().encode(xml)));
  value.inflatedBytes = value.parts.reduce(
    (n: number, p: any) => n + atob(p.data).length,
    0,
  );
  return value;
}
(globalThis as any).fixture = {
  invoke: async (cmd: string, args: any) => {
    calls.push({
      scenario,
      cmd,
      version: args?.file?.version,
      mode: args?.mode,
      atMs: Math.round(performance.now() - started),
    });
    if (
      cmd === "file_delivery_inspect_selected" ||
      cmd === "file_delivery_inspect"
    )
      return file();
    if (cmd === "file_delivery_check_revision") {
      if (failure) throw { code: failure };
      if (args.file.version === `v${diskVersion}` && args.mode === "hint")
        return { kind: "hintUnchanged" };
      return { kind: "verified", file: file() };
    }
    if (cmd === "file_delivery_read_text") {
      const value = {
        file: args.file,
        text:
          marker(args.file.version) +
          "\n" +
          "Controlled reading line\n".repeat(80),
      };
      if (textHold)
        return new Promise((resolve, reject) => {
          deferred = { resolve, reject, value };
        });
      return value;
    }
    if (
      cmd === "file_delivery_read_docx" ||
      cmd === "file_delivery_read_workbook"
    ) {
      const value = capture(args.file);
      if (captureHold)
        return new Promise((resolve, reject) => {
          deferred = { resolve, reject, value };
        });
      return value;
    }
    unexpected.push(cmd);
    throw new Error("Unexpected IPC " + cmd);
  },
};
const appText = () => document.querySelector("#app")?.textContent ?? "";
const count = (cmd: string, version?: string) =>
  calls.filter(
    (c) =>
      c.scenario === scenario &&
      c.cmd === cmd &&
      (!version || c.version === version),
  ).length;
const focus = () => window.dispatchEvent(new Event("focus"));
function mount() {
  flushSync(() =>
    root.render(
      <StrictMode>
        <OpenedFileView
          key={scenario}
          threadKey={`thread-${scenario}`}
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
async function select(name: string, kind = "txt") {
  flushSync(() => root.render(null));
  await pause();
  scenario = name;
  ext = kind;
  diskVersion = 1;
  active = true;
  failure = null;
  invalid = false;
  captureHold = false;
  textHold = false;
  deferred = null;
  document.querySelector("#stage")!.textContent = scenario;
  mount();
  await until(() => appText().includes(marker("v1")));
}
function click(label: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("#app button"),
  ].find((b) => b.textContent?.trim() === label);
  if (!button || button.disabled)
    throw new Error("unavailable button " + label);
  flushSync(() => button.click());
}
function release() {
  if (!deferred) throw new Error("missing deferred capture");
  const pending = deferred;
  deferred = null;
  captureHold = false;
  textHold = false;
  pending.resolve(pending.value);
}
async function screenshot(name: string) {
  document.documentElement.dataset.capture = name;
  await until(() => document.documentElement.dataset.captured === name, 5000);
}

async function run() {
  await select("text-auto");
  const node = document.querySelector("#app pre");
  const reads = count("file_delivery_read_text");
  await until(() => count("file_delivery_check_revision") > 0);
  check(
    "real 5s timer uses metadata hint without reread or DOM replacement",
    calls.find(
      (c) =>
        c.scenario === scenario && c.cmd === "file_delivery_check_revision",
    )?.mode === "hint" &&
      count("file_delivery_read_text") === reads &&
      document.querySelector("#app pre") === node,
  );
  diskVersion = 2;
  textHold = true;
  await until(() => deferred !== null);
  check(
    "changed text keeps old snapshot while next read is pending",
    appText().includes(marker("v1")) && !appText().includes(marker("v2")),
  );
  release();
  await until(() => appText().includes(marker("v2")));
  check(
    "new checked text publishes after read success",
    !appText().includes(marker("v1")),
  );
  active = false;
  mount();
  const hiddenCalls = count("file_delivery_check_revision");
  diskVersion = 3;
  await pause(5250);
  check(
    "hidden selection schedules no check for a full real poll interval",
    count("file_delivery_check_revision") === hiddenCalls,
  );
  active = true;
  mount();
  await until(() => appText().includes(marker("v3")));
  check(
    "reactivation forces content check and fresh text",
    calls
      .filter(
        (c) =>
          c.scenario === scenario && c.cmd === "file_delivery_check_revision",
      )
      .at(-1)?.mode === "content",
  );
  click(S.feedback);
  const textarea =
    document.querySelector<HTMLTextAreaElement>("#app textarea")!;
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(textarea, "Keep my old-version opinion");
  flushSync(() =>
    textarea.dispatchEvent(new Event("input", { bubbles: true })),
  );
  await until(() =>
    Object.values(fileFeedbackDrafts.entries(`thread-${scenario}`)).some(
      (d: any) => d.text === "Keep my old-version opinion",
    ),
  );
  diskVersion = 4;
  const oldReads = count("file_delivery_read_text");
  focus();
  await until(() => appText().includes(S.revisionNotices.newVersion));
  check(
    "active opinion editing defers refresh without reading new body",
    appText().includes(marker("v3")) &&
      count("file_delivery_read_text") === oldReads &&
      textarea.value === "Keep my old-version opinion",
  );
  await screenshot("feedback-version-protected");
  click(S.refresh);
  await until(() => appText().includes(marker("v4")));
  check(
    "explicit reread retains old opinion with original content identity",
    Object.values(fileFeedbackDrafts.entries(`thread-${scenario}`)).some(
      (d: any) =>
        d.text === "Keep my old-version opinion" &&
        d.contentId.includes('"v3"'),
    ),
  );

  for (const code of ["missing", "changing", "pending"]) {
    await select(`text-${code}`);
    failure = code;
    focus();
    await until(() => appText().includes((S.revisionNotices as any)[code]));
    check(
      `${code} keeps old content with accurate stale notice`,
      appText().includes(marker("v1")),
    );
    const stopped = count("file_delivery_check_revision");
    focus();
    active = false;
    mount();
    active = true;
    mount();
    await pause(5250);
    check(
      `${code} does not retry after focus/hide/reopen or next poll`,
      count("file_delivery_check_revision") === stopped,
    );
  }

  for (const kind of ["docx", "xlsx"]) {
    await select(`office-${kind}`, kind);
    check(
      `${kind} initial real worker preview ready`,
      appText().includes(marker("v1")),
    );
    diskVersion = 2;
    captureHold = true;
    focus();
    await until(() => deferred !== null);
    check(
      `${kind} parent stages capture while retaining old rendered document`,
      appText().includes(marker("v1")) && !appText().includes(marker("v2")),
    );
    release();
    await until(() => appText().includes(marker("v2")));
    check(
      `${kind} publishes actual parser success with no duplicate child capture`,
      count(
        `file_delivery_read_${kind === "docx" ? "docx" : "workbook"}`,
        "v2",
      ) === 1 && !appText().includes(marker("v1")),
    );
    if (kind === "xlsx") await screenshot("office-staged-workbook");
    diskVersion = 3;
    invalid = true;
    focus();
    await until(() => appText().includes(S.revisionNotices.refreshFailed));
    check(
      `${kind} actual worker rejection retains prior content and explicit stale notice`,
      appText().includes(marker("v2")) && !appText().includes(marker("v3")),
    );
    const failedChecks = count("file_delivery_check_revision");
    focus();
    await pause(5250);
    check(
      `${kind} parser rejection halts automatic checks`,
      count("file_delivery_check_revision") === failedChecks,
    );
    invalid = false;
    diskVersion = 2;
    click(S.refresh);
    await until(
      () =>
        appText().includes(marker("v2")) &&
        !appText().includes(S.revisionNotices.refreshFailed),
    );
    diskVersion = 4;
    captureHold = true;
    focus();
    await until(() => deferred !== null);
    active = false;
    mount();
    deferred!.reject({ code: "readPending" });
    deferred = null;
    captureHold = false;
    await pause(75);
    active = true;
    mount();
    await until(() => appText().includes(S.revisionNotices.pending));
    const pendingChecks = count("file_delivery_check_revision"),
      pendingReads = count(
        `file_delivery_read_${kind === "docx" ? "docx" : "workbook"}`,
      );
    focus();
    await pause(5250);
    check(
      `${kind} hidden readPending stops checks and new OS-capture attempts`,
      count("file_delivery_check_revision") === pendingChecks &&
        count(`file_delivery_read_${kind === "docx" ? "docx" : "workbook"}`) ===
          pendingReads,
    );
    check(
      `${kind} readPending preserves old successful snapshot`,
      appText().includes(marker("v2")) && !appText().includes(marker("v4")),
    );
    if (kind === "docx") await screenshot("office-pending-old-document");
  }
  check("no send/open/save/Agent IPC", unexpected.length === 0, unexpected);
}
try {
  await run();
} catch (error) {
  results.push({
    scenario,
    name: "unhandled harness failure",
    ok: false,
    error: String(error),
  });
  console.error(error);
} finally {
  const result = {
    passed: results.every((x) => x.ok),
    checks: results,
    calls,
    unexpected,
    realElapsedMs: Math.round(performance.now() - started),
    clock:
      "Unmodified Date/timers; focus/active events are controlled inputs, not native lifecycle proof.",
    scope:
      "Real Chromium/StrictMode/OpenedFileView and production Office workers; IPC is synthetic and no Tauri OS read or user data is accessed.",
  };
  document.querySelector("#result")!.textContent = JSON.stringify(
    result,
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
