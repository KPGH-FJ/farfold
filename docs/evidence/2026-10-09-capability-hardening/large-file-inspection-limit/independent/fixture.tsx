import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { OpenedFileView } from "/src/components/OpenedFileView";
import { FILE_OPEN_STRINGS as S } from "/src/runtime/file_open_strings";
import { FILE_DELIVERY_STRINGS as D } from "/src/runtime/file_delivery_strings";
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
const checks: any[] = [],
  calls: any[] = [],
  unexpected: string[] = [],
  unhandled: string[] = [];
const mode = new URLSearchParams(location.search).get("case") || "fixed";
let scenario = "",
  failure: unknown = null,
  readFailure = false;
const wire = "文件超过当前操作的大小限制";
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const text = () => document.querySelector("#app")?.textContent ?? "";
const buttons = () => [
  ...document.querySelectorAll<HTMLButtonElement>("#app button"),
];
const check = (name: string, ok: unknown, detail?: unknown) =>
  checks.push({ scenario, name, ok: !!ok, detail });
window.addEventListener("unhandledrejection", (e) =>
  unhandled.push(String(e.reason)),
);
async function until(fn: () => unknown) {
  const started = performance.now();
  while (!fn()) {
    if (performance.now() - started > 5000)
      throw new Error("timeout " + scenario + " " + text());
    await pause();
  }
}
(globalThis as any).fixture = {
  invoke: async (cmd: string, args: any) => {
    calls.push({ scenario, cmd, args });
    if (
      cmd === "file_delivery_inspect" ||
      cmd === "file_delivery_inspect_selected"
    ) {
      if (failure !== null) throw failure;
      return {
        root: "/controlled",
        path: args.path,
        resolvedPath: "/controlled/okay.txt",
        name: "okay.txt",
        size: 17,
        sha256: "a".repeat(64),
        version: "controlled-v1",
      };
    }
    if (cmd === "file_delivery_read_text") {
      if (readFailure) throw wire;
      return { file: args.file, text: "OLD_CONTENT_12345\n" };
    }
    if (cmd === "file_delivery_check_revision")
      return { kind: "hintUnchanged" };
    if (
      cmd === "file_delivery_open_selected_location" ||
      cmd === "file_delivery_reveal_selected_location"
    )
      return;
    unexpected.push(cmd);
    throw new Error("unexpected command");
  },
};
function mount(path: string) {
  flushSync(() =>
    root.render(
      <StrictMode>
        <OpenedFileView
          key={scenario}
          threadKey="inspection-review"
          selectionKey={scenario}
          path={path}
          workingDirectory="/controlled"
          active={true}
          onOpenHtml={() => unexpected.push("html")}
        />
      </StrictMode>,
    ),
  );
}
async function capture(label: string) {
  document.documentElement.dataset.capture = label;
  await until(() => document.documentElement.dataset.captured === label);
  delete document.documentElement.dataset.capture;
}
async function run() {
  scenario = "initial-readable";
  failure = null;
  mount("okay.txt");
  await until(() => text().includes("OLD_CONTENT_12345"));
  check("actual parent displays initial controlled text", true);
  const cases = [
    {
      name: "relative-limit",
      path: "oversize-257.txt",
      error: wire,
      expected: T.failures.tooLarge,
    },
    {
      name: "absolute-limit",
      path: "/chosen/oversize-257.txt",
      error: wire,
      expected: T.failures.tooLarge,
    },
    {
      name: "pending",
      path: "pending.txt",
      error: D.checkWaitExpired,
      expected: D.checkWaitExpired,
    },
    {
      name: "busy",
      path: "busy.txt",
      error: D.checkBusy,
      expected: D.checkBusy,
    },
    {
      name: "private-suffix",
      path: "private.txt",
      error: wire + ": synthetic-private-detail",
      expected: S.failed,
    },
    {
      name: "unknown-string",
      path: "unknown.txt",
      error: "synthetic-private-detail",
      expected: S.failed,
    },
  ];
  for (const c of cases) {
    scenario = c.name;
    failure = c.error;
    mount(c.path);
    await until(() =>
      buttons().some((b) => b.textContent === T.revealLocation),
    );
    check("exact expected notice", text().includes(c.expected), {
      expected: c.expected,
      actual: document.querySelector("#app [role=status]")?.textContent,
    });
    check(
      "old content and private details absent",
      !text().includes("OLD_CONTENT_12345") &&
        !text().includes("synthetic-private-detail"),
    );
    check(
      "fallback and retry remain explicit",
      buttons().some((b) => b.textContent === T.openLocation) &&
        buttons().some((b) => b.textContent === T.revealLocation) &&
        buttons().some((b) => b.textContent === S.retry) &&
        text().includes(T.locationScope),
    );
    check(
      "failed inspection performs no content read/copy or external action",
      calls
        .filter((x) => x.scenario === scenario)
        .every(
          (x) =>
            x.cmd === "file_delivery_inspect" ||
            x.cmd === "file_delivery_inspect_selected",
        ),
    );
    const before = calls.filter((x) => x.scenario === scenario).length;
    await pause(150);
    check(
      "no automatic retry after failure",
      calls.filter((x) => x.scenario === scenario).length === before,
    );
    if (c.name.includes("limit")) {
      if (c.name === "relative-limit") await capture(`inspection-${mode}`);
      check(
        "no successful copy action offered",
        !buttons().some((b) => b.textContent === T.save),
      );
      buttons()
        .find((b) => b.textContent === T.revealLocation)!
        .click();
      await pause();
      const shown = calls.filter(
        (x) =>
          x.scenario === scenario &&
          x.cmd === "file_delivery_reveal_selected_location",
      );
      check(
        "explicit reveal uses exact selected location",
        shown.length === 1 &&
          JSON.stringify(shown[0].args) ===
            JSON.stringify(
              c.path.startsWith("/")
                ? { path: c.path }
                : { path: c.path, root: "/controlled" },
            ),
      );
      buttons()
        .find((b) => b.textContent === T.openLocation)!
        .click();
      await pause();
      check(
        "explicit open is separately dispatched",
        calls.filter(
          (x) =>
            x.scenario === scenario &&
            x.cmd === "file_delivery_open_selected_location",
        ).length === 1,
      );
    }
  }
  scenario = "small-reader-limit";
  failure = null;
  readFailure = true;
  mount("small.txt");
  await until(() => buttons().some((b) => b.textContent === T.revealLocation));
  check(
    "small text limit not relabelled as 256 MiB",
    text().includes(S.failed) && !text().includes(T.failures.tooLarge),
  );
  check(
    "reader uses real wrapper command",
    calls.some(
      (x) => x.scenario === scenario && x.cmd === "file_delivery_read_text",
    ),
  );
  check(
    "no unexpected IPC or unhandled rejection",
    unexpected.length === 0 && unhandled.length === 0,
    { unexpected, unhandled },
  );
}
run()
  .catch((e) =>
    checks.push({ name: "harness error", ok: false, error: String(e) }),
  )
  .finally(() => {
    const result = {
      mode,
      passed: checks.every((c) => c.ok),
      checks,
      calls,
      unhandled,
      unexpected,
      boundary:
        "Actual React StrictMode, OpenedFileView and fileDelivery. Only Tauri invoke is controlled; OS file IO/dialog/opener/native app are not executed. Baseline uses exact installed-commit wrapper through Vite load plugin; production files never reverted.",
    };
    document.querySelector("#result")!.textContent = JSON.stringify(
      result,
      null,
      2,
    );
    document.documentElement.dataset.done = "true";
  });
