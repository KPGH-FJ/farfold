import React, { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ConversationFind } from "/src/components/ConversationFind";
import {
  TranscriptSearchContext,
  SearchDisclosure,
} from "/src/components/transcript-search";
import {
  MessageContent,
  MessageAttachments,
} from "/src/components/MessageContent";
import { UserMessageContent } from "/src/components/UserMessageContent";
import { ToolStep, PlanBlock } from "/src/components/thread-items";
import { CompactionCard } from "/src/components/CompactionCard";
import { transcriptRanges } from "/src/runtime/transcript_find_dom";
import { CONVERSATION_REDESIGN as R } from "/src/runtime/conversation_redesign_strings";
import "/src/styles.css";
import "/src/styles-settings.css";
import "/src/styles-content.css";
import "/src/styles-thread.css";
import "/src/styles-artifact.css";
import "/src/product-shell.css";
import "/src/conversation-workspace.css";
import "/src/history-import.css";
import "/src/desktop-workbench.css";
const results: { name: string; ok: boolean; detail?: unknown }[] = [];
let ipc = 0,
  fileOpens = 0;
(window as any).__TAURI_INTERNALS__ = {
  invoke: () => {
    ipc++;
    throw new Error("Unexpected IPC in search fixture");
  },
};
const pause = () =>
  new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 20)));
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  if (!ok) throw new Error(name);
}
const source = {};
const attachments = [
  {
    name: "image-needle",
    kind: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFSoAAAAASUVORK5CYII=",
  },
  { name: "audio", kind: "audio", mimeType: "audio/wav", data: "AAAA" },
  { name: "third", text: "third text" },
  { name: "fourth", text: "fourth-needle" },
] as any;
const call = {
  toolCallId: "tool",
  title: "command",
  kind: "execute",
  status: "completed",
  locations: [],
  startedAt: 0,
  content: [
    { type: "text", text: "tool-needle" },
    {
      type: "diff",
      path: "/test",
      oldText: null,
      newText: Array.from({ length: 70 }, (_, i) =>
        i === 65 ? "diff-tail-needle" : `line ${i}`,
      ).join("\n"),
    },
  ],
} as any;
const compact = {
  id: "compact",
  kind: "compaction",
  status: "completed",
  summary: [{ type: "text", text: "summary-needle" }],
  details: {},
  summaryDetails: [],
} as any;
let setFind: (v: boolean) => void,
  setText: (v: string) => void,
  setOwner: (v: string) => void;
function Fixture() {
  const [find, f] = useState(false),
    [text, t] = useState("stream-needle"),
    [owner, o] = useState("A");
  setFind = f;
  setText = t;
  setOwner = o;
  const host = useRef<HTMLDivElement>(null);
  return (
    <TranscriptSearchContext.Provider value={find}>
      <div ref={host}>
        {find && (
          <ConversationFind
            key={`find-${owner}`}
            host={host}
            revision={text + owner}
            onClose={() => f(false)}
          />
        )}
        <div className="transcript" key={`body-${owner}`}>
          <SearchDisclosure className="thought">
            <summary>Thought</summary>
            <p data-find-block>thought-needle</p>
          </SearchDisclosure>
          <MessageContent
            source={source}
            text={
              "**Farf**old\n\nalpha\n\nbeta\n\nSee [report.md](/tmp/report.md)"
            }
            onOpenFile={() => fileOpens++}
          />
          <UserMessageContent historical={false} text={text} />
          <MessageAttachments attachments={attachments} />
          <SearchDisclosure className="tool-group">
            <summary>Steps</summary>
            <ToolStep call={call} />
          </SearchDisclosure>
          <PlanBlock
            entries={[
              { content: "plan-needle", priority: "normal", status: "pending" },
            ]}
          />
          <CompactionCard item={compact} />
        </div>
      </div>
    </TranscriptSearchContext.Provider>
  );
}
const browserErrors: string[] = [];
const app = document.querySelector("#app")!;
const root = createRoot(app, {
  onUncaughtError: (error) => browserErrors.push(String(error)),
});
const transcript = () => app.querySelector<HTMLElement>(".transcript")!;
const count = () => app.querySelector(".conversation-find-count")?.textContent;
async function query(value: string) {
  const input = app.querySelector(".thread-find input") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
  await pause();
}
async function find(value: string) {
  flushSync(() => setFind(true));
  await pause();
  await query(value);
}
async function close() {
  flushSync(() => setFind(false));
  await pause();
  await pause();
}
async function run() {
  flushSync(() =>
    root.render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    ),
  );
  await pause();
  const original = transcript().querySelector(".message-text")!.textContent;
  await find("thought-needle");
  check(
    "folded thought counted and revealed",
    count() === R.findPosition(1, 1) &&
      app.querySelector<HTMLDetailsElement>(".thought")!.open,
    {
      count: count(),
      open: app.querySelector<HTMLDetailsElement>(".thought")!.open,
      value: (app.querySelector("input") as HTMLInputElement).value,
      direct: transcriptRanges(transcript(), "thought-needle").length,
    },
  );
  await close();
  check(
    "temporary thought expansion revoked",
    !app.querySelector<HTMLDetailsElement>(".thought")!.open,
    {
      html: app.querySelector(".thought")!.outerHTML,
      props: Object.entries(app.querySelector(".thought")!)
        .filter(([key]) => key.startsWith("__reactProps"))
        .map(([, value]: any) => ({
          open: value.open,
          click: !!value.onClick,
          toggle: !!value.onToggle,
        })),
    },
  );
  (app.querySelector(".thought summary") as HTMLElement).click();
  await pause();
  await find("thought-needle");
  await close();
  check(
    "preexisting user expansion survives",
    app.querySelector<HTMLDetailsElement>(".thought")!.open,
  );
  (app.querySelector(".thought summary") as HTMLElement).click();
  await pause();
  await find("thought-needle");
  (app.querySelector(".thought summary") as HTMLElement).click();
  await pause();
  check(
    "manual collapse stays collapsed without losing count",
    !app.querySelector<HTMLDetailsElement>(".thought")!.open &&
      count() === R.findPosition(1, 1),
  );
  await close();
  await find("fourth-needle");
  check(
    "fourth attachment text located",
    count() === R.findPosition(1, 1) &&
      [...app.querySelectorAll("pre")].some(
        (n) =>
          n.textContent === "fourth-needle" && n.getClientRects().length > 0,
      ),
  );
  check(
    "search adds no image or audio decoder",
    app.querySelectorAll("img,audio").length === 0,
  );
  await close();
  await find("image-needle");
  check(
    "automatic attachment opening still does not mount media",
    app.querySelectorAll("img,audio").length === 0,
  );
  const mediaButton = [...app.querySelectorAll("button")].find(
    (n) => n.textContent === R.findShowMedia,
  )!;
  mediaButton.click();
  await pause();
  check(
    "explicit media action admits only selected image",
    app.querySelectorAll("img").length === 1 &&
      app.querySelectorAll("audio").length === 0,
  );
  await close();
  check(
    "user media and ancestor choice survive search close",
    app.querySelectorAll("img").length === 1,
  );
  (app.querySelector(".message-attachment summary") as HTMLElement).click();
  await pause();
  check(
    "manual media close removes decoder",
    app.querySelectorAll("img,audio").length === 0,
  );
  await find("alphabeta");
  check(
    "paragraph boundary cannot create phantom phrase",
    count() === "没有匹配内容",
  );
  await query("Farfold");
  check(
    "inline formatting matches as one phrase",
    count() === R.findPosition(1, 1),
  );
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(transcriptRanges(transcript(), "Farfold")[0]);
  check(
    "native text selection remains exact across formatting",
    selection.toString() === "Farfold" &&
      app.querySelectorAll("mark").length === 0,
  );
  selection.removeAllRanges();
  await query("report.md");
  check(
    "file-link button body remains searchable",
    count() === R.findPosition(1, 1) && fileOpens === 0,
  );
  await query("tool-needle");
  check(
    "nested tool text is visible at its hit",
    count() === R.findPosition(1, 1) &&
      [...app.querySelectorAll("pre")].some(
        (n) => n.textContent === "tool-needle" && n.getClientRects().length > 0,
      ),
  );
  await query("diff-tail-needle");
  check(
    "clipped diff tail resolves exact loaded line",
    count() === R.findPosition(1, 1) &&
      [...app.querySelectorAll("[data-find-block]")].some(
        (n) =>
          n.textContent?.includes("diff-tail-needle") &&
          n.getClientRects().length > 0,
      ),
  );
  await query("plan-needle");
  check("plan is searchable", count() === R.findPosition(1, 1));
  await query("summary-needle");
  check(
    "folded compaction summary is searchable",
    count() === R.findPosition(1, 1) &&
      app.querySelector<HTMLDetailsElement>(".compaction-summary")!.open,
  );
  await query("stream-needle");
  flushSync(() => setText("stream-needle stream-needle"));
  await pause();
  check(
    "stream updates refresh occurrence count",
    count() === R.findPosition(1, 2),
  );
  flushSync(() => setOwner("B"));
  await pause();
  check(
    "thread switch discards old query and highlights",
    (app.querySelector(".thread-find input") as HTMLInputElement).value ===
      "" && count() === "",
  );
  await close();
  check(
    "no leaked temporary disclosure or text mutation",
    !app.querySelector<HTMLDetailsElement>(".tool-group")!.open &&
      transcript().textContent?.includes("Farfold"),
  );
  check(
    "search preserves the original displayed message text",
    transcript().querySelector(".message-text")!.textContent === original,
  );
  const nativeHighlight = (window as any).Highlight;
  (window as any).Highlight = undefined;
  await find("thought-needle");
  check(
    "without Custom Highlight support the hit still counts and reveals",
    count() === R.findPosition(1, 1) &&
      app.querySelector<HTMLDetailsElement>(".thought")!.open,
  );
  await close();
  (window as any).Highlight = nativeHighlight;
  check("no app IPC or file action", ipc === 0 && fileOpens === 0, {
    ipc,
    fileOpens,
  });
  // No registry holds document strings: compare exact mounted nodes after repeat close.
  const memory = () => {
    (window as any).gc?.();
    return (performance as any).memory?.usedJSHeapSize ?? null;
  };
  const bigText = "A realistic loaded message with details. ".repeat(50);
  const bigCall = {
    ...call,
    content: [{ type: "text", text: "large-needle " + bigText.repeat(5) }],
  };
  let change: (v: boolean) => void;
  function Large() {
    const [active, set] = useState(false);
    change = set;
    const host = useRef<HTMLDivElement>(null);
    return (
      <TranscriptSearchContext.Provider value={active}>
        <div ref={host}>
          {active && (
            <ConversationFind
              host={host}
              revision={1}
              onClose={() => set(false)}
            />
          )}
          <div className="transcript">
            {Array.from({ length: 1000 }, (_, i) => (
              <UserMessageContent key={i} historical={false} text={bigText} />
            ))}
            {Array.from({ length: 120 }, (_, i) => (
              <ToolStep
                key={1000 + i}
                call={{ ...bigCall, toolCallId: `large-${i}` }}
              />
            ))}
          </div>
        </div>
      </TranscriptSearchContext.Provider>
    );
  }
  flushSync(() =>
    root.render(
      <StrictMode>
        <Large />
      </StrictMode>,
    ),
  );
  await pause();
  const baseNodes = app.querySelectorAll("*").length,
    baseHeap = memory(),
    cycles = [];
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    flushSync(() => change(true));
    await pause();
    const scan = performance.now();
    const matches = transcriptRanges(transcript(), "large-needle");
    const scanMs = performance.now() - scan;
    const openNodes = app.querySelectorAll("*").length;
    flushSync(() => change(false));
    await pause();
    cycles.push({
      openCloseMs: performance.now() - start,
      scanMs,
      matches: matches.length,
      openNodes,
      closedNodes: app.querySelectorAll("*").length,
      heapAfterClose: memory(),
    });
    check(
      `large search cycle ${i + 1} returns original DOM`,
      matches.length === 120 && app.querySelectorAll("*").length === baseNodes,
    );
  }
  results.push({
    name: "controlled scale",
    ok: true,
    detail: {
      messages: 1000,
      tools: 120,
      loadedCharacters: 1000 * bigText.length + 120 * (bigText.length * 5 + 13),
      baseNodes,
      baseHeap,
      cycles,
    },
  });
  let highRoot: HTMLDivElement | null = null;
  function Many() {
    const host = useRef<HTMLDivElement>(null);
    return (
      <TranscriptSearchContext.Provider value={true}>
        <div
          ref={(node) => {
            host.current = node;
            highRoot = node;
          }}
        >
          <ConversationFind host={host} revision={1} onClose={() => {}} />
          <div className="transcript">
            <p data-find-block>{"x ".repeat(160000)}</p>
          </div>
        </div>
      </TranscriptSearchContext.Provider>
    );
  }
  flushSync(() =>
    root.render(
      <StrictMode>
        <Many />
      </StrictMode>,
    ),
  );
  await pause();
  const highStart = performance.now();
  await query("x");
  await pause();
  check(
    "160000 matches do not exceed highlight argument limit",
    count() === R.findPosition(1, 160000) && browserErrors.length === 0,
    {
      count: count(),
      errors: browserErrors,
      elapsedMs: performance.now() - highStart,
      highlights: (CSS as any).highlights?.get("conversation-find")?.size,
    },
  );
  flushSync(() => root.unmount());
  check(
    "highlights released on close",
    !(CSS as any).highlights?.has("conversation-find"),
  );
}
run()
  .catch((error) =>
    results.push({
      name: "exception",
      ok: false,
      detail: String(error?.stack ?? error),
    }),
  )
  .finally(() => {
    document.querySelector("#result")!.textContent = JSON.stringify(
      {
        engine: navigator.userAgent,
        results,
        passed: results.every((r) => r.ok),
      },
      null,
      2,
    );
    document.documentElement.dataset.done = "true";
  });
