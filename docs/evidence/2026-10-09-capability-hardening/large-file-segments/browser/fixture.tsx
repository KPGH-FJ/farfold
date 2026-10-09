import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { TextBlockPreview } from "/src/components/TextBlockPreview";
import { FileCopyJobsStatus } from "/src/components/FileCopyJobsStatus";
import { fileCopyJobs } from "/src/runtime/file_copy_jobs";
import { TEXT_BLOCK_STRINGS as S } from "/src/runtime/text_block_strings";
import { FILE_COPY_STRINGS as C } from "/src/runtime/file_copy_strings";
import "/src/styles.css";
import "/src/styles-artifact.css";
const root = createRoot(document.querySelector("#app")!);
const results: any[] = [],
  calls: any[] = [],
  statuses: any[] = [],
  clip: string[] = [];
const file = {
  root: "/fixture",
  path: "/fixture/large.md",
  resolvedPath: "/fixture/large.md",
  name: "large.md",
  size: 131072 * 16,
  version: "1",
  sha256: "synthetic-v1",
};
const sized = (prefix: string) =>
  prefix + "a".repeat(131072 - new TextEncoder().encode(prefix).length);
const block = (index: number, f = file) => ({
  file: f,
  blockIndex: index,
  blockCount: 16,
  byteStart: index * 131072,
  byteEnd: (index + 1) * 131072,
  startLine: index + 1,
  endLine: index + 2,
  startsMidLine: index > 0,
  endsMidLine: index < 15,
  text: sized(
    index === 0 ? "# 首行 0 false 空\n" : "第 " + (index + 1) + " 片段\n",
  ),
});
const initial = block(0),
  position = { current: null as any };
let pending: { resolve: (v: any) => void; reject: (v: any) => void } | null =
  null;
let delayRead = false,
  copyState = "copying",
  startLost = false;
const ready = {
  operationId: "controlled-copy",
  file,
  destination: "/fixture/out.md",
  state: "ready",
  settled: false,
  bytesCopied: 0,
  total: file.size,
};
const complete = {
  ...ready,
  state: "completed",
  settled: true,
  bytesCopied: file.size,
  receipt: {
    kind: "fileCopy",
    destination: ready.destination,
    size: file.size,
    sha256: file.sha256,
    sourceVersion: file.version,
  },
};
(globalThis as any).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: any) => {
    calls.push({ cmd, args: structuredClone(args) });
    if (cmd === "file_delivery_read_text_block") {
      if (delayRead)
        return new Promise((resolve, reject) => {
          pending = { resolve, reject };
        });
      return block(args.blockIndex, args.file);
    }
    if (cmd === "file_copy_prepare") return ready;
    if (cmd === "file_copy_start") {
      if (startLost) throw { code: "unavailable" };
      return { ...ready, state: copyState };
    }
    if (cmd === "file_copy_status")
      return copyState === "completed"
        ? complete
        : { ...ready, state: copyState };
    if (cmd === "file_copy_cancel") {
      copyState = "completed";
      return complete;
    }
    if (cmd === "file_copy_release") return true;
    throw new Error("unexpected IPC " + cmd);
  },
};
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      clip.push(text);
    },
  },
});
const pause = () => new Promise((r) => setTimeout(r, 20));
async function until(fn: () => unknown) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await pause();
  }
  throw new Error(
    "fixture wait expired " +
      document.querySelector("#app")?.textContent?.slice(0, 300),
  );
}
function check(name: string, ok: unknown, detail?: unknown) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) throw new Error(name);
}
function mount(active = true, b = initial, key = b.file.version) {
  flushSync(() =>
    root.render(
      <StrictMode>
        <div style={{ width: 620, maxWidth: "100%" }}>
          <TextBlockPreview
            key={key}
            initial={b}
            active={active}
            readingPosition={position}
            onStatus={(s) => statuses.push(s)}
          />
          <FileCopyJobsStatus />
        </div>
      </StrictMode>,
    ),
  );
}
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
function click(label: string) {
  const b = button(label);
  if (!b || b.disabled) throw new Error("button unavailable " + label);
  flushSync(() => b.click());
}
async function capture(name: string) {
  document.documentElement.dataset.capture = name;
  await until(() => document.documentElement.dataset.captured === name);
}
try {
  mount();
  await pause();
  check(
    "StrictMode initial block uses supplied receipt and performs zero IPC",
    calls.length === 0,
  );
  check(
    "large Markdown remains literal source without fragment parsing",
    document.querySelector("pre")?.textContent === initial.text &&
      !document.querySelector("h1"),
  );
  check(
    "exact global lines, byte interval and continuation visible",
    document.body.textContent?.includes("第 1–2 行") &&
      document.body.textContent?.includes("131,072") &&
      document.body.textContent?.includes(S.continuation(initial)),
  );
  check(
    "long line remains inside fixed content pane",
    document.documentElement.scrollWidth <= window.innerWidth &&
      document.querySelector(".text-block-preview")!.getBoundingClientRect()
        .width <= 620,
  );
  click(S.copy);
  await pause();
  check(
    "clipboard receives current fragment only",
    clip[0] === initial.text &&
      new TextEncoder().encode(clip[0]).length === 131072 &&
      file.size > 131072,
  );
  await capture("fragment-initial");
  click(S.next);
  await until(
    () => document.querySelector("pre")?.textContent === block(1).text,
  );
  check(
    "next navigation sends exact file and ordinary non-restoring index",
    calls[0].cmd === "file_delivery_read_text_block" &&
      calls[0].args.blockIndex === 1 &&
      calls[0].args.restorePosition === false &&
      calls[0].args.file.version === "1",
  );
  check(
    "only block position retained without content or version ledger",
    position.current.kind === "text" &&
      position.current.blockIndex === 1 &&
      Object.keys(position.current).sort().join() ===
        ["root", "resolvedPath", "kind", "blockIndex"].sort().join(),
  );
  delayRead = true;
  click(S.next);
  await until(() => pending);
  const inflight = pending!;
  check(
    "in-flight read retains old text",
    document.querySelector("pre")?.textContent === block(1).text,
  );
  click(S.cancel);
  check(
    "cancel reports pending OS read and disables overlapping navigation",
    button(S.next).disabled && document.body.textContent?.includes(S.waiting),
  );
  const count = calls.length;
  mount(false);
  mount(true);
  await pause();
  check(
    "hide/show does not start another block request",
    calls.length === count,
  );
  inflight.resolve(block(2));
  pending = null;
  await pause();
  check(
    "cancelled late success never replaces old block",
    document.querySelector("pre")?.textContent === block(1).text,
  );
  delayRead = false;
  click(S.retry);
  await until(
    () => document.querySelector("pre")?.textContent === block(2).text,
  );
  check(
    "explicit retry restores navigation",
    position.current.blockIndex === 2,
  );
  delayRead = true;
  click(S.next);
  await until(() => pending);
  mount(false);
  pending!.reject({ code: "pending" });
  pending = null;
  await pause();
  mount(true);
  await pause();
  check(
    "late hidden native pending retained and no automatic retry",
    statuses.at(-1).code === "pending" &&
      document.body.textContent?.includes(S.failures.pending),
  );
  const v2 = { ...file, version: "2", sha256: "v2" };
  mount(true, block(0, v2), "2");
  await pause();
  check(
    "new verified version resets current content without old details",
    document.querySelector("pre")?.textContent === block(0, v2).text &&
      position.current.blockIndex === 0,
  );
  startLost = true;
  await fileCopyJobs.begin(file, ready.destination);
  await pause();
  check(
    "lost start receipt visible as unknown instead of saved",
    document.body.textContent?.includes(C.uncertain) &&
      !document.body.textContent?.includes(C.states.completed),
  );
  await capture("copy-unconfirmed");
  const prepareCount = calls.filter(
    (c) => c.cmd === "file_copy_prepare",
  ).length;
  await fileCopyJobs.begin(file, ready.destination);
  check(
    "uncertain save cannot start duplicate writer",
    calls.filter((c) => c.cmd === "file_copy_prepare").length === prepareCount,
  );
  copyState = "publishing";
  click(C.check);
  await until(() => document.body.textContent?.includes(C.states.publishing));
  click(C.cancel);
  await until(() => document.body.textContent?.includes(C.states.completed));
  check(
    "publishing cancellation shows actual completed result",
    fileCopyJobs.getSnapshot()[0].status?.state === "completed" &&
      !document.body.textContent?.includes(C.states.cancelled),
  );
  await capture("copy-completed");
  click(C.close);
  await until(() => fileCopyJobs.getSnapshot().length === 0);
  check(
    "explicit record close releases only terminal backend job",
    calls.at(-1).cmd === "file_copy_release",
  );
  check(
    "no Agent or unexpected file action used",
    calls.every((c) =>
      [
        "file_delivery_read_text_block",
        "file_copy_prepare",
        "file_copy_start",
        "file_copy_status",
        "file_copy_cancel",
        "file_copy_release",
      ].includes(c.cmd),
    ),
  );
} catch (error) {
  results.push({
    name: "unexpected",
    ok: false,
    error: String(error),
    stack: (error as Error).stack,
  });
} finally {
  root.unmount();
  document.querySelector("#result")!.textContent = JSON.stringify(
    {
      passed: results.every((r) => r.ok),
      checks: results.length,
      results,
      calls,
      statuses,
      scope:
        "Actual React StrictMode/Chromium; fixed synthetic IPC/clipboard, no native file IO or Agent.",
    },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
