import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { invoke } from "@tauri-apps/api/core";
import { ArtifactPane } from "./ArtifactPane";
import { appendToolOutput, paneCards } from "../runtime/artifacts";
import {
  applyConnectionLost,
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "../runtime/session_projection";
import type { ThreadState, ToolCallView } from "../runtime/session_types";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";

// Use the real card derivation and ArtifactPane/FileArtifactView SSR. Only the
// external IPC boundary is inert; no private component or React hook is mocked.
const sources = [
  "command",
  "log",
  "diff",
  "edit-input",
  "write-input",
] as const;
type Source = (typeof sources)[number];
const output = "P18_OUTPUT_BEGIN\r\n  literal <tag> & 🙂\t\nP18_OUTPUT_END\n";
const oldText = "P18_OLD_BEGIN\r\n  original 🙂\t\nP18_OLD_END\n";
const newText = "P18_NEW_BEGIN\r\n  replacement 🙂\t\nP18_NEW_END\n";
const path = "/synthetic/p18/report.txt";
let serial = 0;

function seed(source: Source, status: string) {
  const thread = freshThreadState(
    `p18-tool-activity-${++serial}`,
    "agent",
    "/synthetic/p18",
    "native",
  );
  thread.running = true;
  thread.connectionId = "current-connection";
  thread.activeToolCallIds = ["original-tool"];
  const rawInput =
    source === "edit-input"
      ? { filePath: path, oldString: oldText, newString: newText }
      : source === "write-input"
        ? { filePath: path, content: newText }
        : { literal: "P18_RAW_INPUT\r\n🙂", retained: { value: null } };
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "original-tool",
    title: `P18 ${source}`,
    kind: source === "command" ? "execute" : source === "log" ? "read" : "edit",
    status,
    rawInput,
    ...(source === "command"
      ? { rawOutput: { output, exitCode: 37, extra: "unchanged" } }
      : source === "log"
        ? { rawOutput: { output: "", extra: "empty priority preserved" } }
        : {}),
    content:
      source === "diff"
        ? [{ type: "diff", path, oldText, newText }]
        : source === "log" || source === "command"
          ? [{ type: "content", content: { type: "text", text: output } }]
          : [],
  });
  const item = thread.items.find((entry) => entry.kind === "tool");
  if (item?.kind !== "tool") throw new Error("Missing original tool fixture");
  return { thread, call: item.call };
}

function stopped(thread: ThreadState) {
  applyTurnEnd(thread, { stopReason: "cancelled" });
  expect(thread.running).toBe(false);
  expect(thread.activeToolCallIds).toEqual(["original-tool"]);
}

function history(thread: ThreadState, owner?: string) {
  thread.historyUnavailable = {
    reason: "incomplete",
    sourceKnown: true,
    ...(owner ? { toolActivityConnectionId: owner } : {}),
  };
}

function assertPresentation(
  source: Source,
  thread: ThreadState,
  call: ToolCallView,
  status: string,
  expectedOutput = output,
) {
  const original = structuredClone(call);
  const cards = paneCards(thread);
  expect(cards).toHaveLength(1);
  const card = cards[0];
  expect.soft(card).toMatchObject({ status });
  if (source === "command" || source === "log") {
    expect.soft(card).toMatchObject({
      kind: source,
      title: `P18 ${source}`,
      output: expectedOutput,
      failed: call.status === "failed",
    });
  } else {
    expect.soft(card).toMatchObject({
      kind: "diff",
      path,
      oldText: source === "write-input" ? null : oldText,
      newText,
      scope: "fragment",
      source,
    });
  }

  const ipcBefore = vi.mocked(invoke).mock.calls.length;
  const html = renderToStaticMarkup(<ArtifactPane thread={thread} active />);
  expect.soft(vi.mocked(invoke).mock.calls.slice(ipcBefore)).toEqual([]);
  if (source === "command" || source === "log") {
    // The toolbar also has a failed-log filter option. Inspect the rendered
    // output card header so its fixed options cannot satisfy status assertions.
    const header = html.match(/<div class="a-card-h">([\s\S]*?)<\/div>/)?.[1];
    expect.soft(header).toContain(`P18 ${source}`);
    const labels = [
      W.stepsRunning,
      W.stepsPending,
      STRINGS.thread.toolResultUnknown,
    ];
    const expected =
      status === "in_progress"
        ? W.stepsRunning
        : status === "pending"
          ? W.stepsPending
          : status === "unknown"
            ? STRINGS.thread.toolResultUnknown
            : null;
    for (const label of labels)
      if (label === expected) expect.soft(header).toContain(label);
      else expect.soft(header).not.toContain(label);
    if (call.status === "failed")
      expect.soft(header).toContain(STRINGS.artifacts.failedLog);
    else expect.soft(header).not.toContain(STRINGS.artifacts.failedLog);
    if (source === "log" && call.status === "completed")
      expect.soft(header).toContain(STRINGS.artifacts.log);
    expect.soft(html).toContain("P18_OUTPUT_BEGIN");
    expect.soft(html).toContain("P18_OUTPUT_END");
  } else {
    const expected =
      status === "failed"
        ? W.fileFailed
        : status === "unknown"
          ? W.fileUnknown
          : status !== "completed"
            ? W.filePending
            : null;
    for (const label of [W.fileFailed, W.fileUnknown, W.filePending])
      if (label === expected) expect.soft(html).toContain(label);
      else expect.soft(html).not.toContain(label);
    expect
      .soft(html)
      .toContain(source === "diff" ? W.fileReported : W.fileInput);
    expect.soft(html).toContain(W.fragmentNote);
    expect.soft(html).toContain("P18_NEW_BEGIN");
  }
  // Presentation uncertainty belongs to the card, never the official call.
  expect.soft(call).toEqual(original);
  expect
    .soft(thread.items.find((item) => item.kind === "tool")?.call)
    .toBe(call);
}

const cases: {
  name: string;
  reported: string;
  shown: string;
  arrange: (thread: ThreadState) => void;
}[] = [
  {
    name: "official in-progress tools remain active after reply cancellation",
    reported: "in_progress",
    shown: "in_progress",
    arrange: stopped,
  },
  {
    name: "official pending tools remain waiting after reply cancellation",
    reported: "pending",
    shown: "pending",
    arrange: stopped,
  },
  ...(["in_progress", "pending"] as const).map((reported) => ({
    name: `disconnected ${reported} tools become unknown without rewriting calls`,
    reported,
    shown: "unknown",
    arrange: (thread: ThreadState) => {
      stopped(thread);
      applyConnectionLost(thread);
    },
  })),
  {
    name: "absent activity IDs do not prove a pending tool is still waiting",
    reported: "pending",
    shown: "unknown",
    arrange: (thread) => {
      thread.activeToolCallIds = [];
    },
  },
  {
    name: "another active ID does not make this tool currently running",
    reported: "in_progress",
    shown: "unknown",
    arrange: (thread) => {
      thread.activeToolCallIds = ["different-tool"];
    },
  },
  {
    name: "unqualified history activity IDs remain unknown",
    reported: "in_progress",
    shown: "unknown",
    arrange: (thread) => history(thread),
  },
  {
    name: "historical activity from another connection remains unknown",
    reported: "pending",
    shown: "unknown",
    arrange: (thread) => history(thread, "former-connection"),
  },
  ...(["in_progress", "pending"] as const).map((reported) => ({
    name: `actual current-connection history evidence qualifies ${reported}`,
    reported,
    shown: reported,
    arrange: (thread: ThreadState) => history(thread, "current-connection"),
  })),
  {
    name: "a historical owner without a current connection is not live proof",
    reported: "in_progress",
    shown: "unknown",
    arrange: (thread) => {
      history(thread, "former-connection");
      delete thread.connectionId;
    },
  },
  ...(["completed", "failed"] as const).map((reported) => ({
    name: `reported ${reported} survives disconnection and stale history ownership`,
    reported,
    shown: reported,
    arrange: (thread: ThreadState) => {
      history(thread, "former-connection");
      thread.activeToolCallIds = [];
      applyConnectionLost(thread);
    },
  })),
];

for (const source of sources) {
  it.each(cases)(`${source}: $name`, ({ reported, shown, arrange }) => {
    const { thread, call } = seed(source, reported);
    const original = structuredClone(call);
    arrange(thread);
    assertPresentation(source, thread, call, shown);
    expect.soft(call.status).toBe(reported);
    expect.soft(call).toEqual(original);
  });

  it.each(["completed", "failed"] as const)(
    `${source}: a late %s receipt replaces uncertainty without changing payloads`,
    (terminal) => {
      const { thread, call } = seed(source, "in_progress");
      const { rawInput, rawOutput, content, locations } = structuredClone(call);
      stopped(thread);
      applyConnectionLost(thread);
      assertPresentation(source, thread, call, "unknown");
      applyUpdate(thread, {
        sessionUpdate: "tool_call_update",
        toolCallId: call.toolCallId,
        status: terminal,
      });
      expect.soft(call).toMatchObject({
        status: terminal,
        rawInput,
        ...(rawOutput === undefined ? {} : { rawOutput }),
        content,
        locations,
      });
      assertPresentation(source, thread, call, terminal);
    },
  );
}

it.each(["pending", "in_progress"] as const)(
  "keeps terminal-output priority and its exact bytes when %s becomes unknown",
  (reported) => {
    const { thread, call } = seed("command", reported);
    const terminalOutput = output.replace("literal", "terminal priority");
    applyUpdate(thread, {
      sessionUpdate: "tool_call_update",
      toolCallId: call.toolCallId,
      content: [{ type: "terminal", terminalId: "owned-terminal" }],
    });
    appendToolOutput(thread, {
      toolCallId: call.toolCallId,
      terminalId: "owned-terminal",
      data: terminalOutput,
    });
    const original = structuredClone(call);
    applyConnectionLost(thread);
    assertPresentation("command", thread, call, "unknown", terminalOutput);
    expect.soft(call).toEqual(original);
  },
);
