import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { OpenedFileView } from "/src/components/OpenedFileView";
import {
  composerDrafts,
  fileFeedbackDrafts,
  draftPersistence,
} from "/src/runtime/drafts";
import { FILE_OPEN_STRINGS as S } from "/src/runtime/file_open_strings";
import { WORKSPACE_STRINGS as W } from "/src/runtime/workspace_strings";
import { VISUAL_PREVIEW_STRINGS as V } from "/src/runtime/visual_preview";
import "/src/styles.css";
import "/src/styles-settings.css";
import "/src/styles-content.css";
import "/src/styles-thread.css";
import "/src/styles-artifact.css";
import "/src/product-shell.css";
import "/src/conversation-workspace.css";
import "/src/desktop-workbench.css";
const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const calls: string[] = [];
const pause = () =>
  new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 20)));
async function until(read: () => unknown) {
  for (let i = 0; i < 900; i++) {
    if (read()) return;
    await pause();
  }
  throw new Error("wait expired: " + document.body.textContent?.slice(-1500));
}
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  if (!ok) throw new Error(name);
}
function button(text: string) {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((x) => x.textContent?.trim() === text);
}
async function click(text: string) {
  const b = button(text);
  check("button available: " + text, !!b && !b.disabled);
  flushSync(() => b!.click());
  await pause();
}
function input(text: string) {
  const target = document.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(target, text);
  flushSync(() => target.dispatchEvent(new Event("input", { bubbles: true })));
}
async function capture(label: string) {
  document.documentElement.dataset.capture = label;
  await until(() => document.documentElement.dataset.captured === label);
}
function makePdf(changed = false) {
  const stream = (color: string) => `q ${color} rg 20 20 280 150 re f Q`;
  const first = stream(changed ? "0.7 0.2 0.5" : "0.15 0.35 0.65"),
    second = stream("0.2 0.55 0.25");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << >> /Contents 6 0 R >>",
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
  ];
  let value = "%PDF-1.7\n",
    offsets = [0];
  objects.forEach((s, i) => {
    offsets.push(value.length);
    value += `${i + 1} 0 obj\n${s}\nendobj\n`;
  });
  const xref = value.length;
  value +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return value;
}
let raw = makePdf(),
  kind = "pdf",
  revision = 1,
  file: any;
const imageCanvas = document.createElement("canvas");
imageCanvas.width = 640;
imageCanvas.height = 240;
const imageContext = imageCanvas.getContext("2d")!;
imageContext.fillStyle = "#244966";
imageContext.fillRect(0, 0, 640, 240);
imageContext.fillStyle = "#e4f0f2";
imageContext.fillRect(40, 40, 160, 160);
imageContext.fillStyle = "#80bbaf";
imageContext.fillRect(235, 80, 90, 120);
imageContext.fillRect(360, 55, 90, 145);
imageContext.fillRect(485, 25, 90, 175);
const imageData = imageCanvas.toDataURL("image/png").split(",")[1];
async function updateFile() {
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const path = `/controlled/result.${kind}`;
  file = {
    root: "/controlled",
    path,
    resolvedPath: path,
    name: `result.${kind}`,
    size: raw.length,
    version: `v${revision}`,
    sha256: digest,
  };
}
let saved: any = null;
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (name: string, args: any) => {
    calls.push(name);
    if (name === "settings_get") return saved;
    if (name === "settings_set") {
      saved = structuredClone(args.value);
      return;
    }
    if (name === "file_delivery_inspect_selected") return structuredClone(file);
    if (name === "file_delivery_read_visual")
      return {
        file: structuredClone(file),
        mimeType: kind === "pdf" ? "application/pdf" : "image/png",
        data: btoa(raw),
      };
    throw new Error("unexpected IPC " + name);
  },
};
let setVisible: (value: boolean) => void = () => {};
function Fixture() {
  const [active, setActive] = useState(true);
  setVisible = setActive;
  return (
    <main
      style={{
        width: 600,
        maxWidth: "100%",
        margin: "20px auto",
        height: "auto",
      }}
    >
      <OpenedFileView
        threadKey="visual-fixture"
        path={file.path}
        workingDirectory="/controlled"
        active={active}
        selectionKey={kind}
        onOpenHtml={() => {
          throw new Error("unexpected HTML");
        }}
      />
    </main>
  );
}
const root = createRoot(document.querySelector("#app")!);
async function run() {
  await updateFile();
  await draftPersistence.load();
  root.render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await until(() => button(S.feedback) && !button(S.feedback)!.disabled);
  const canvas = document.querySelector("canvas")!;
  check(
    "real PDF worker completed with visible pixels",
    !canvas.hidden &&
      canvas.width > 0 &&
      canvas.getContext("2d")!.getImageData(100, 100, 1, 1).data[3] > 0,
    { width: canvas.width, height: canvas.height },
  );
  await click(S.feedback);
  input("Controlled page one opinion");
  await click("针对当前第 1 页");
  const first = Object.values(fileFeedbackDrafts.entries("visual-fixture"))[0];
  check(
    "page one anchor uses exact disk digest",
    first.anchor?.page === 1 && first.contentId?.includes(file.sha256) === true,
  );
  check(
    "next-page control is available",
    !!button(V.next) && !button(V.next)!.disabled,
  );
  flushSync(() => button(V.next)!.click());
  check(
    "pending page removes selectable target but preserves previous opinion",
    !Array.from(document.querySelectorAll("button")).some((b) =>
      b.textContent?.includes("针对当前第"),
    ) &&
      document.body.textContent!.includes("意见针对第 1 / 2 页") &&
      document.querySelector("textarea")?.value ===
        "Controlled page one opinion",
  );
  await until(() => button("针对当前第 2 页"));
  check(
    "page navigation preserves existing target and text",
    document.body.textContent!.includes("意见针对第 1 / 2 页") &&
      document.querySelector("textarea")?.value ===
        "Controlled page one opinion",
  );
  await capture("pdf-page2-retained");
  flushSync(() => setVisible(false));
  await pause();
  check(
    "hide withdraws page target while retaining opinion",
    !button("针对当前第 2 页") &&
      Object.values(fileFeedbackDrafts.entries("visual-fixture"))[0] === first,
  );
  flushSync(() => setVisible(true));
  await until(() => button("针对当前第 2 页"));
  await click(W.feedbackAdd);
  check(
    "take appends original page and version without sending",
    composerDrafts
      .read("session:visual-fixture")
      .text.includes("第 1 / 2 页") &&
      composerDrafts.read("session:visual-fixture").text.includes(file.sha256),
  );
  await click(S.feedback);
  input("Controlled old-version page two opinion");
  await click("针对当前第 2 页");
  const old = Object.values(fileFeedbackDrafts.entries("visual-fixture"))[0];
  raw = makePdf(true);
  revision++;
  await updateFile();
  await click(S.refresh);
  await until(() => button(S.feedback) && !button(S.feedback)!.disabled);
  check(
    "changed version does not retarget retained draft",
    Object.values(fileFeedbackDrafts.entries("visual-fixture"))[0] === old &&
      !old.contentId!.includes(file.sha256),
  );
  const details = Array.from(document.querySelectorAll("details")).find((e) =>
    e.textContent?.includes("Controlled old-version"),
  );
  if (details) details.open = true;
  await pause();
  await capture("version-changed-retained");
  if (details) {
    details.scrollTop = details.scrollHeight;
    await pause();
    check(
      "retained-version actions are reachable by scrolling",
      Array.from(details.querySelectorAll("button")).some((b) => {
        const r = b.getBoundingClientRect(),
          d = details.getBoundingClientRect();
        return (
          b.textContent?.includes("加入输入框") &&
          r.top >= d.top &&
          r.bottom <= d.bottom
        );
      }),
    );
    await capture("version-changed-actions");
  }
  kind = "png";
  raw = atob(imageData);
  revision++;
  await updateFile();
  root.render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await until(
    () =>
      document.querySelector("img")?.complete &&
      button(S.feedback) &&
      !button(S.feedback)!.disabled,
  );
  await click(S.feedback);
  input("Controlled image file opinion");
  check(
    "image offers file-level target with loaded pixels",
    document.body.textContent!.includes("意见针对整个文件") &&
      !document.body.textContent!.includes("针对当前第"),
  );
  await capture("image-opinion");
  await click(W.feedbackAdd);
  await draftPersistence.flush();
  check(
    "only file-read and draft settings calls occurred",
    calls.every((n) =>
      [
        "settings_get",
        "settings_set",
        "file_delivery_inspect_selected",
        "file_delivery_read_visual",
      ].includes(n),
    ),
    calls,
  );
  check(
    "moving image opinion retains previous PDF draft",
    Object.values(fileFeedbackDrafts.entries("visual-fixture"))[0] === old,
  );
  root.unmount();
  document.querySelector("#result")!.textContent = JSON.stringify(
    {
      passed: true,
      results,
      counts: { checks: results.length, ipc: calls.length },
      scope:
        "real React StrictMode/PDF worker/image browser; fixed local bytes and IPC fixture; no installed WebKit or Agent",
    },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
run().catch((error) => {
  document.querySelector("#result")!.textContent = JSON.stringify(
    { passed: false, results, error: String(error), calls },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
});
