import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { OpeningElicitationList } from "/src/components/OpeningElicitationList";
import { openingInquiries } from "/src/runtime/opening_inquiries";
import "/src/styles.css";
import "/src/styles-settings.css";
import "/src/styles-content.css";
import "/src/styles-thread.css";
import "/src/styles-artifact.css";
import "/src/product-shell.css";
import "/src/conversation-workspace.css";
import "/src/desktop-workbench.css";
const checks: { name: string; ok: boolean }[] = [];
const calls: { command: string; args: unknown }[] = [];
let openOutcome: "opened" | "failed" | "pending" = "opened";
let resolveOpen: (() => void) | undefined;
(window as any).__TAURI_INTERNALS__ = {
  invoke(command: string, args: unknown) {
    calls.push({ command, args });
    if (command === "plugin:opener|open_url") {
      if (openOutcome === "failed") return Promise.reject(new Error("Controlled opener failure"));
      if (openOutcome === "pending") return new Promise<void>((r) => { resolveOpen = r; });
      return Promise.resolve();
    }
    if (command === "session_elicitation_respond") return Promise.resolve({ status: "submitted" });
    throw new Error("unexpected IPC " + command);
  },
};
const pause = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 20)));
async function until(fn: () => unknown) { for (let i = 0; i < 100; i++) { if (fn()) return; await pause(); } throw new Error("bounded UI wait"); }
function check(name: string, ok: boolean) { checks.push({ name, ok }); if (!ok) throw new Error(name); }
async function click(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  check("enabled explicit action: " + text, !!button && !button.disabled);
  flushSync(() => button!.click()); await pause();
}
async function capture(label: string) { document.documentElement.dataset.capture = label; await until(() => document.documentElement.dataset.captured === label); }
const question = (id: string) => ({ kind: "elicitation", requestId: id, mode: "url", url: "https://xn--bcher-kva.example.test/confirm?step=controlled-only", message: "请核对地址，然后决定是否继续。", owner: { connectionId: "controlled", requestId: id }, request: { mode: "url", _meta: { future: null } } });
async function main() {
  const root = createRoot(document.querySelector("#app")!);
  flushSync(() => root.render(<StrictMode><OpeningElicitationList agents={[{ id: "fixture", name: "受控 Agent" }]} /></StrictMode>));
  const owner = openingInquiries.begin("one", { agentId: "fixture", cwd: "/controlled/project" });
  flushSync(() => owner.receive(question("one"))); await until(() => document.querySelector("dialog")?.open);
  check("full URL visible before consent", document.body.textContent!.includes(question("one").url));
  check("agent and working location disclosed", document.body.textContent!.includes("受控 Agent") && document.body.textContent!.includes("/controlled/project"));
  check("punycode warning is visible", document.body.textContent!.includes("国际化域名编码"));
  check("no clickable remote link or embed", !document.querySelector("a[href],iframe,img,video,audio"));
  check("no open or IPC before choice", calls.length === 0);
  check("URL card has no form controls", !document.querySelector("input,textarea,select"));
  const dialog = document.querySelector("dialog")!;
  check("dialog fits viewport", dialog.getBoundingClientRect().width <= innerWidth && dialog.getBoundingClientRect().height <= innerHeight);
  await capture("inquiry-disclosure");
  await click("同意并打开");
  check("one explicit opener delivery", calls.filter((c) => c.command === "plugin:opener|open_url").length === 1);
  check("accept omits form content", (calls.find((c) => c.command === "session_elicitation_respond")!.args as any).content === null);
  check("waiting is separate from completion", document.body.textContent!.includes("等待外部步骤") && !document.body.textContent!.includes("已报告外部步骤结束"));
  flushSync(() => owner.receive({ kind: "elicitationComplete", requestId: "unowned" }));
  check("unknown completion ignored", owner.snapshot().requests.length === 1);
  flushSync(() => owner.receive({ kind: "elicitationComplete", requestId: "one" }));
  check("actual complete does not claim parent result", document.body.textContent!.includes("原操作的结果另行确认"));
  owner.finish(); openingInquiries.dismiss(owner.snapshot().id); await pause();
  openOutcome = "failed";
  const failed = openingInquiries.begin("two", { agentId: "fixture", cwd: "/controlled/failure" });
  flushSync(() => failed.receive(question("two"))); await pause(); const before = calls.length;
  await click("同意并打开");
  check("failed opener has visible error and no accept", document.body.textContent!.includes("浏览器未能确认打开") && calls.length === before + 1);
  await click("拒绝"); failed.finish(); openingInquiries.dismiss(failed.snapshot().id); await pause();
  openOutcome = "pending";
  const cancel = openingInquiries.begin("three", { agentId: "fixture", cwd: "/controlled/cancel" });
  flushSync(() => cancel.receive(question("three"))); await pause();
  await click("同意并打开"); await click("取消"); const cancelledCalls = calls.length;
  resolveOpen!(); await pause();
  check("late browser return does not submit consent", calls.length === cancelledCalls);
  cancel.finish(); openingInquiries.dismiss(cancel.snapshot().id); await pause();
  check("all dialogs close after their owners finish", !document.querySelector("dialog"));
  root.unmount();
  return { passed: checks.every((c) => c.ok), checks, calls, boundary: "Controlled Chromium React/DOM with mocked IPC and browser opener; no external login, Agent, real native opener or installed app." };
}
try { document.querySelector("#result")!.textContent = JSON.stringify(await main(), null, 2); }
catch (e) { document.querySelector("#result")!.textContent = JSON.stringify({ passed: false, checks, calls, error: String(e) }, null, 2); }
finally { document.documentElement.dataset.done = "true"; }
