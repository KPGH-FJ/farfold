import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SourceTextSelection } from "../../../../../src/components/SourceTextSelection";
import { createTextFeedbackSource } from "../../../../../src/runtime/text_feedback_range";
import "../../../../../src/styles.css";

const block = new URLSearchParams(location.search).get("block") === "1";
const text = block
  ? "当前长行片段😀"
  : "\uFEFFfirst\r\nrepeat repeat\r\n第三行😀末尾\r\nfinal";
const size = new TextEncoder().encode(text).length;
const file = {
  root: "/controlled",
  path: "/controlled/source.txt",
  resolvedPath: "/controlled/source.txt",
  name: "source.txt",
  size: block ? 2 * 1024 * 1024 : size,
  sha256: "a".repeat(64),
  version: "controlled-v1",
};
const receipt = block
  ? {
      file,
      text,
      blockIndex: 0,
      blockCount: 17,
      byteStart: 0,
      byteEnd: size,
      startLine: 1,
      endLine: 1,
      startsMidLine: false,
      endsMidLine: true,
    }
  : { file, text };
const source = createTextFeedbackSource(receipt, file);
if (!source) throw new Error("Invalid controlled source");
const events: any[] = [];
const confirmations: any[] = [];
const describe = (node: Node | null) =>
  node instanceof Element
    ? `${node.tagName}:${node.getAttribute("type") ?? ""}:${node.getAttribute("aria-label") ?? node.textContent?.slice(0, 30)}`
    : node?.nodeType === 3
      ? "#text"
      : null;
function state() {
  const selection = document.getSelection();
  const action = Array.from(document.querySelectorAll("button")).find(
    (v) => v.textContent === "对此选段提意见",
  );
  return {
    focused: describe(document.activeElement),
    rangeCount: selection?.rangeCount,
    collapsed: selection?.isCollapsed,
    text: selection?.toString(),
    anchor: describe(selection?.anchorNode ?? null),
    anchorOffset: selection?.anchorOffset,
    focus: describe(selection?.focusNode ?? null),
    focusOffset: selection?.focusOffset,
    confirmDisabled: action?.disabled,
    confirmations: [...confirmations],
  };
}
for (const type of [
  "keydown",
  "keypress",
  "keyup",
  "submit",
  "click",
  "focusin",
  "focusout",
  "selectionchange",
]) {
  document.addEventListener(
    type,
    (event) => {
      events.push({
        type,
        target: describe(event.target as Node),
        key: (event as KeyboardEvent).key,
        state: state(),
      });
      queueMicrotask(() =>
        events.push({ type: `${type}:microtask`, state: state() }),
      );
    },
    true,
  );
}
Object.assign(window, {
  fixture: {
    events,
    confirmations,
    state,
    clear: () => {
      events.length = 0;
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ padding: 32, width: 720 }}>
      <h1>当前原文测试</h1>
      <SourceTextSelection
        source={source}
        enabled={true}
        onAvailability={(value) =>
          events.push({
            type: "availability",
            available: value.available,
            state: state(),
          })
        }
        onConfirm={(value) => {
          confirmations.push(value.anchor);
          events.push({
            type: "confirm",
            anchor: value.anchor,
            state: state(),
          });
        }}
      />
      <button id="outside">外部控件</button>
    </main>
  </StrictMode>,
);
