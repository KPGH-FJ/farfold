import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DraftStartup } from "/src/components/DraftStartup";
import { FileCopyActivity } from "/src/components/FileCopyActivity";
import { FileCopyJobsStatus } from "/src/components/FileCopyJobsStatus";
import { fileCopyJobs } from "/src/runtime/file_copy_jobs";
import { FILE_COPY_STRINGS as S } from "/src/runtime/file_copy_strings";
import { EXIT_IMPACT as E } from "/src/runtime/exit_impact";
import "/src/styles.css";
import "/src/styles-artifact.css";
import "/src/styles-settings.css";
import "/src/styles-content.css";
import "/src/styles-thread.css";
import "/src/product-shell.css";
import "/src/conversation-workspace.css";
import "/src/history-import.css";
import "/src/desktop-workbench.css";

const started = performance.now(),
  checks: any[] = [],
  calls: any[] = [],
  unexpected: string[] = [],
  unhandled: string[] = [];
const mode = new URLSearchParams(location.search).get("case") ?? "jobs-copy";
const listeners = new Map<number, { event: string; handler: number }>();
let nextListener = 0,
  latePrepare: ((x: any) => void) | null = null;
const file = {
  root: "/controlled",
  path: "/controlled/complete-original.txt",
  resolvedPath: "/controlled/complete-original.txt",
  name: "complete-original.txt",
  size: 2097152,
  version: "controlled-v1",
  sha256: "controlled-complete-digest",
};
const destination = "/controlled-output/complete-original.txt";
const ready = {
  operationId: "controlled-save-17",
  file,
  destination,
  state: "ready",
  settled: false,
  bytesCopied: 0,
  total: file.size,
};
let status: any = { ...ready, state: "copying", bytesCopied: 128 * 1024 };
(globalThis as any).fixture = {
  invoke: async (cmd: string, args: any) => {
    calls.push({ cmd, args, atMs: Math.round(performance.now() - started) });
    if (cmd === "settings_get") return null;
    if (
      cmd === "settings_set" ||
      cmd === "app_drafts_ready" ||
      cmd === "app_exit_cancel" ||
      cmd === "app_exit_after_save"
    )
      return;
    if (cmd === "plugin:event|listen") {
      const id = ++nextListener;
      listeners.set(id, args);
      return id;
    }
    if (cmd === "plugin:event|unlisten") {
      listeners.delete(args.eventId);
      return;
    }
    if (cmd === "file_copy_prepare") {
      if (mode === "jobs-prepare")
        return new Promise((resolve) => (latePrepare = resolve));
      return ready;
    }
    if (cmd === "file_copy_start") {
      if (mode === "jobs-absence")
        throw new Error("controlled start reply lost");
      return status;
    }
    if (cmd === "file_copy_status")
      return mode === "jobs-absence"
        ? { operationId: ready.operationId, absent: true, settled: true }
        : status;
    if (cmd === "file_copy_cancel") {
      status = { ...ready, state: "cancelled", settled: true };
      return status;
    }
    if (cmd === "file_copy_release") return true;
    unexpected.push(cmd);
    throw new Error("Unexpected IPC " + cmd);
  },
};
window.addEventListener("unhandledrejection", (e) =>
  unhandled.push(String(e.reason)),
);
const root = createRoot(document.querySelector("#app")!);
function App() {
  const [open, setOpen] = useState(true);
  return (
    <DraftStartup>
      <aside>
        <FileCopyActivity />
      </aside>
      <main>
        {open ? (
          <>
            <h2>Controlled source preview</h2>
            <button onClick={() => setOpen(false)}>
              Close controlled preview
            </button>
            <FileCopyJobsStatus file={file} />
          </>
        ) : (
          <p>Controlled preview is closed.</p>
        )}
      </main>
    </DraftStartup>
  );
}
const pause = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const text = () => document.body.textContent ?? "";
const count = (cmd: string) => calls.filter((c) => c.cmd === cmd).length;
async function until(fn: () => unknown, limit = 5000) {
  const start = performance.now();
  while (!fn()) {
    if (performance.now() - start > limit)
      throw new Error("timeout: " + text().slice(0, 2200));
    await pause();
  }
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label && !b.closest("[inert]"),
  );
}
function click(label: string) {
  const b = button(label);
  if (!b || b.disabled) throw new Error("button unavailable " + label);
  flushSync(() => b.click());
}
function check(name: string, ok: unknown, detail?: unknown) {
  checks.push({
    name,
    ok: Boolean(ok),
    detail,
    atMs: Math.round(performance.now() - started),
  });
  if (!ok) throw new Error(name);
}
function emit(event: string, payload: number) {
  for (const [id, l] of listeners)
    if (l.event === event)
      (window as any).controlCallbacks.get(l.handler)({ event, id, payload });
}
async function shot(name: string) {
  document.documentElement.dataset.capture = name;
  await until(() => document.documentElement.dataset.captured === name);
}
try {
  flushSync(() =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
  await until(
    () =>
      count("app_drafts_ready") > 0 &&
      text().includes("Controlled source preview"),
  );
  const begin = fileCopyJobs.begin(file, destination);
  if (mode === "jobs-prepare") {
    await until(() => latePrepare !== null);
    check(
      "preparation is visible and holds exit before observation expires",
      text().includes(S.preparing) && fileCopyJobs.hasUnsettled(),
    );
    await until(
      () => fileCopyJobs.getSnapshot()[0]?.phase === "notStarted",
      12000,
    );
    await begin;
    check(
      "real ten-second prepare timeout withdraws start intent",
      performance.now() - started >= 10000 &&
        count("file_copy_start") === 0 &&
        !fileCopyJobs.hasUnsettled(),
    );
    click(S.close);
    await until(() => fileCopyJobs.getSnapshot().length === 0);
    latePrepare!(ready);
    await until(() => count("file_copy_release") === 1);
    check(
      "late ready after closed card is precisely cancelled and released without start",
      count("file_copy_cancel") === 1 &&
        calls.find((c) => c.cmd === "file_copy_cancel").args.operationId ===
          ready.operationId &&
        count("file_copy_start") === 0 &&
        fileCopyJobs.getSnapshot().length === 0,
    );
    emit("app:save-before-exit", 117);
    await until(() => count("app_exit_after_save") === 1);
    check(
      "withdrawn no-IO preparation does not trap normal quit",
      !document.querySelector('[role="dialog"]') &&
        calls.find((c) => c.cmd === "app_exit_after_save").args
          .confirmActivity === undefined,
    );
    await shot("jobs-prepare-withdrawn");
  } else {
    await begin;
    click("Close controlled preview");
    click(S.activityCount(1));
    await until(() => text().includes(S.activityTitle));
    check(
      "saving remains reachable from global activity after preview closes",
      text().includes("Controlled preview is closed.") &&
        text().includes(destination) &&
        Boolean(button(S.check)),
    );
    click(S.back);
    if (mode === "jobs-absence") {
      await fileCopyJobs.check(fileCopyJobs.getSnapshot()[0].id);
      check(
        "exact absence proves no current IO without claiming completed or cancelled",
        fileCopyJobs.getSnapshot()[0].absence === true &&
          !fileCopyJobs.hasUnsettled() &&
          fileCopyJobs.getSnapshot()[0].phase === "uncertain",
      );
      emit("app:save-before-exit", 119);
      await until(() => text().includes(E.title));
      check(
        "absent task still requires explicit unknown-result exit review",
        count("app_exit_after_save") === 0 &&
          Boolean(button(E.exit)) &&
          !button(E.exit)!.disabled &&
          text().includes(E.copyUnknown),
      );
      await shot("jobs-absent-exit-review");
      click(E.exit);
      await until(() => count("app_exit_after_save") === 1);
      check(
        "explicit absent-result exit never starts another save",
        count("file_copy_start") === 1 &&
          calls.find((c) => c.cmd === "app_exit_after_save").args
            .confirmActivity === true,
      );
    } else {
      emit("app:save-before-exit", 118);
      await until(() => text().includes(E.title));
      check(
        "copying disables quit while cancel remains reachable inside exit dialog",
        button(E.exit)?.disabled === true &&
          Boolean(button(S.cancel)) &&
          count("app_exit_after_save") === 0,
      );
      await shot("jobs-copying-exit-blocked");
      click(S.cancel);
      await until(() => text().includes(S.states.cancelled));
      check(
        "confirmed cancellation unlocks quit only after actual terminal receipt",
        !fileCopyJobs.hasUnsettled() &&
          button(E.exit)?.disabled === false &&
          count("file_copy_cancel") === 1,
      );
      click(E.stay);
      await until(
        () => Boolean(button(S.activityCount(1))) && !text().includes(E.title),
      );
      check(
        "stay cancels the exact exit and restores global access",
        calls.find((c) => c.cmd === "app_exit_cancel").args.token === 118 &&
          Boolean(button(S.activityCount(1))),
      );
      await fileCopyJobs.dismiss(fileCopyJobs.getSnapshot()[0].id);
      status = {
        ...ready,
        state: "unknown",
        settled: true,
        bytesCopied: file.size,
        code: "cleanupUnknown",
      };
      await fileCopyJobs.begin(file, destination);
      emit("app:save-before-exit", 120);
      await until(() => text().includes(E.title));
      check(
        "finished unknown permits only explicit reviewed exit and never renders success",
        !fileCopyJobs.hasUnsettled() &&
          button(E.exit)?.disabled === false &&
          text().includes(E.copyUnknown) &&
          !text().includes(S.states.completed) &&
          count("app_exit_after_save") === 0,
      );
      await shot("jobs-finished-unknown-review");
      click(E.exit);
      await until(() => count("app_exit_after_save") === 1);
      check(
        "unknown result exit uses explicit confirmation without repeat save",
        calls.find((c) => c.cmd === "app_exit_after_save").args
          .confirmActivity === true && count("file_copy_start") === 2,
      );
    }
  }
  check(
    "only controlled settings, file-copy and exit IPC used with no unhandled errors",
    unexpected.length === 0 && unhandled.length === 0,
    { unexpected, unhandled },
  );
} catch (error) {
  checks.push({ name: "sequence failure", ok: false, error: String(error) });
} finally {
  document.querySelector("#result")!.textContent = JSON.stringify(
    {
      mode,
      passed: checks.every((x) => x.ok),
      checks,
      calls,
      unhandled,
      unexpected,
      realElapsedMs: Math.round(performance.now() - started),
      boundary:
        "Actual Chromium StrictMode DraftStartup/FileCopyActivity/FileCopyJobsStatus and production singleton. Synthetic Tauri IPC and events; no OS copy, native quit, actual Agent or user data. Timers and clock unmodified.",
    },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
