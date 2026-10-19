import { expect, it, vi } from "vitest";
import { renderToStaticMarkup as renderStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { TranscriptSearchContext } from "./transcript-search";
// SSR presentation only: materialize hidden text for the existing assertions.
// This does not assert that a collapsed idle view has mounted its body.
function renderToStaticMarkup(node: ReactNode) {
  return renderStaticMarkup(
    <TranscriptSearchContext.Provider value={true}>
      {node}
    </TranscriptSearchContext.Provider>,
  );
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import {
  ReportedDetails,
  REPORTED_DETAILS_STRINGS as D,
} from "./ReportedDetails";
import { ThreadView } from "./ThreadView";
import { ToolStep } from "./thread-items";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";
import { STRINGS } from "../runtime/strings";

it("labels the field view honestly and renders untrusted strings as inert text", () => {
  const html = renderToStaticMarkup(
    <ReportedDetails
      details={{ "/future": "<script>window.leak()</script>", "/null": null }}
    />,
  );
  expect(html).toContain(D.title);
  expect(html).toContain(D.note);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("null");
  expect(html).not.toContain(" open");
  expect(renderToStaticMarkup(<ReportedDetails />)).toBe("");
});

it("shows message and session-level details through the shared thread", () => {
  const state = freshThreadState("view", "fixture", "/work", "n");
  applyUpdate(state, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "answer" },
    _meta: { messageExtra: true },
  });
  applyUpdate(state, {
    sessionUpdate: "usage_update",
    used: 2,
    size: 10,
    _meta: { sessionExtra: true },
  });
  const html = renderToStaticMarkup(
    <ThreadView
      thread={state}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
  expect(html).toContain("messageExtra");
  expect(html).toContain("sessionExtra");
  expect(html.match(new RegExp(D.title, "g"))).toHaveLength(2);
});

it("offers tool details when only an unconsumed field was reported", () => {
  const state = freshThreadState("tool", "fixture", "/work", "n");
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "t",
    title: "Task",
    _meta: { only: true },
  });
  const item = state.items[0];
  if (item?.kind !== "tool") throw new Error("missing fixture tool");
  const html = renderToStaticMarkup(<ToolStep call={item.call} />);
  expect(html).toContain(STRINGS.thread.toolDetail);
});
