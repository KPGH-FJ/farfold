import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import {
  applyTurnEnd,
  applyUpdate,
  threads,
  type ThreadItem,
  type ThreadState,
} from "../runtime/sessions";
import { ArtifactPane } from "./ArtifactPane";
import { ThreadView } from "./ThreadView";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { STRINGS } from "../runtime/strings";
import { ToolStep } from "./thread-items";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";
import { applySessionEvent } from "../runtime/session_event_projection";
import { reportedArtifactFiles } from "../runtime/reported_artifacts";
import { ReportedFilesList } from "./ReportedFilesList";

type Element = ReactElement<Record<string, unknown>>;
type Settled = Extract<ThreadItem, { kind: "settled" }>;
let serial = 0;
function state() {
  const id = `artifact-round-${++serial}`;
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  return s;
}
function round(
  s: ThreadState,
  files: [string, string][],
  output?: string,
): Settled {
  s.roundItemBase = s.items.length;
  for (const [path, newText] of files)
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: `file-${++serial}`,
      title: path,
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path, oldText: null, newText }],
    });
  if (output)
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: `output-${++serial}`,
      title: output,
      kind: "execute",
      status: "completed",
      rawOutput: output,
    });
  applyTurnEnd(s, { stopReason: "end_turn" });
  return s.items.at(-1) as Settled;
}

// Render real components, retaining their actual event handlers. No DOM,
// production hook override, Agent process, filesystem content or IPC is used.
function capture(render: () => ReactNode): Element[] {
  let tree: ReactNode;
  function Capture() {
    tree = render();
    return tree;
  }
  renderToStaticMarkup(<Capture />);
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
      visit(child.props.fileSelector as ReactNode);
      visit(child.props.headerSupplement as ReactNode);
    });
  visit(tree);
  return elements;
}
const pointerClick = (node: Element, opener = {} as HTMLElement) =>
  (node.props.onClick as (event: unknown) => void)({ currentTarget: opener });
function roundClick(
  s: ThreadState,
  settled: Settled,
  artifactReturnFocusRef?: { current: HTMLElement | null },
) {
  const row = capture(() =>
    ThreadView({
      thread: s,
      active: true,
      agents: [],
      onGoSettings: () => {},
      onOpened: () => {},
      artifactReturnFocusRef,
    }),
  ).find((node) => node.props.item === settled)!;
  expect(row).toBeDefined();
  const button = capture(() =>
    (row.type as (props: Record<string, unknown>) => ReactNode)(row.props),
  ).find((node) => node.props.className === "round-sum round-artifacts")!;
  expect(button).toBeDefined();
  return (opener?: HTMLElement) => pointerClick(button, opener);
}
function toolLink(
  s: ThreadState,
  itemId: string,
  artifactReturnFocusRef?: { current: HTMLElement | null },
) {
  const item = s.items.find((entry) => entry.id === itemId);
  if (item?.kind !== "tool") throw new Error("Expected real tool item");
  const step = capture(() =>
    ThreadView({
      thread: s,
      active: true,
      agents: [],
      onGoSettings: () => {},
      onOpened: () => {},
      artifactReturnFocusRef,
    }),
  ).find((node) => node.type === ToolStep && node.props.call === item.call)!;
  return capture(() =>
    (step.type as (props: Record<string, unknown>) => ReactNode)(step.props),
  ).find(
    (node) => node.type === "button" && node.props.children === T.viewArtifacts,
  );
}
const pane = (s: ThreadState) =>
  capture(() => ArtifactPane({ thread: s, active: true }));
const picker = (s: ThreadState) =>
  pane(s).find(
    (node) =>
      node.type === "select" && node.props["aria-label"] === W.fileChoice,
  )!;
const options = (s: ThreadState) =>
  Children.toArray(picker(s).props.children as ReactNode)
    .filter(isValidElement<Record<string, unknown>>)
    .filter((node) => node.type === "option")
    .map((node) => node.props.value);
const html = (s: ThreadState) =>
  renderToStaticMarkup(<ArtifactPane thread={s} active />);
function select(s: ThreadState, value: string) {
  (picker(s).props.onChange as (event: unknown) => void)({
    target: { value },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
});

it("opens each declared file input's own fragment from the shared path's source list", () => {
  const s = state();
  for (const [id, before, after] of [
    ["first", "ALPHA", "BETA"],
    ["second", "BETA", "GAMMA"],
  ]) {
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: id,
      kind: "other",
      status: "completed",
      rawInput: {
        target: "/p/shared.md",
        previous: before,
        replacement: after,
      },
      locations: [{ path: "/p/shared.md", line: 1 }],
    });
    applySessionEvent(
      s,
      {
        kind: "toolFileInput",
        source: "reported",
        toolCallId: id,
        fields: {
          operation: "edit",
          path: "target",
          oldText: "previous",
          newText: "replacement",
        },
      },
      false,
    );
  }
  applyTurnEnd(s, { stopReason: "end_turn" });
  const ended = s.items.at(-1) as Settled;
  roundClick(s, ended)();
  const entries = reportedArtifactFiles(s, ended.id)!;
  expect(entries).toHaveLength(1);
  expect(entries[0].origins).toHaveLength(2);
  for (const [index, expected, absent] of [
    [0, "ALPHA", "GAMMA"],
    [1, "GAMMA", "ALPHA"],
  ] as const) {
    roundClick(s, ended)();
    const list = pane(s).find((n) => n.type === ReportedFilesList)!;
    (list.props.onOpenSource as (entry: unknown, origin: unknown) => void)(
      entries[0],
      entries[0].origins[index],
    );
    expect(s.artifactPaneTarget?.roundId).toBe(
      entries[0].origins[index].toolItemId,
    );
    expect(html(s)).toContain(expected);
    expect(html(s)).not.toContain(absent);
    expect(html(s)).toContain("拟写入");
    expect(html(s)).toContain("片段");
  }
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([name]) => name.startsWith("file_") || name.startsWith("acp_"),
      ),
  ).toEqual([]);
});

it("opens each step's own version of the same path and returns to its containing round", () => {
  const s = state();
  const ended = round(s, [
    ["/p/shared.md", "FIRST-VERSION"],
    ["/p/shared.md", "SECOND-VERSION"],
  ]);
  const [first, second] = s.items.filter((item) => item.kind === "tool");
  expect(toolLink(s, first.id)).toBeDefined();
  pointerClick(toolLink(s, first.id)!);
  expect(html(s)).toContain("FIRST-VERSION");
  expect(html(s)).not.toContain("SECOND-VERSION");
  expect(html(s)).toContain(W.chooseStepContent);
  expect(html(s)).not.toContain(W.chooseRoundLatest);
  pointerClick(toolLink(s, second.id)!);
  expect(html(s)).toContain("SECOND-VERSION");
  expect(html(s)).not.toContain("FIRST-VERSION");
  const back = pane(s).find(
    (node) =>
      node.type === "button" && node.props.children === W.showRoundContent,
  )!;
  expect(back).toBeDefined();
  (back.props.onClick as () => void)();
  expect(s.artifactPaneTarget?.roundId).toBe(ended.id);
  expect(html(s)).toContain(W.roundContent);
});

it("uses neutral file selection hints for input-derived content in all, round and step scopes", () => {
  const s = state();
  s.roundItemBase = s.items.length;
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: `proposed-${++serial}`,
    title: "Proposed edit",
    kind: "edit",
    status: "failed",
    rawInput: {
      filePath: "/p/proposed.txt",
      oldString: "BEFORE",
      newString: "PROPOSED",
    },
  });
  const tool = s.items.at(-1)!;
  applyTurnEnd(s, { stopReason: "end_turn" });
  const ended = s.items.at(-1) as Settled;
  const assertHint = (hint: string) => {
    const selector = pane(s).find(
      (node) => node.props.className === "artifact-file-picker",
    )!;
    expect(selector.props.title).toBe(`/p/proposed.txt\n${hint}`);
    expect(selector.props.title).not.toContain("返回");
    expect(selector.props.title).not.toContain("收到");
    expect(html(s)).toContain("PROPOSED");
    expect(html(s)).toContain(W.fileFailed);
  };
  threads.openArtifactPane(s.key);
  assertHint(W.chooseLatest);
  roundClick(s, ended)();
  assertHint(W.chooseRoundLatest);
  pointerClick(toolLink(s, tool.id)!);
  assertHint(W.chooseStepContent);
});

it("shares actual step and round openers with the pane without replacing them during pane navigation", () => {
  const s = state();
  const ended = round(s, [["/p/shared.md", "VERSION"]]);
  const step = s.items.find((item) => item.kind === "tool")!;
  const returnFocus = { current: null as HTMLElement | null };
  const stepButton = {} as HTMLElement;
  pointerClick(toolLink(s, step.id, returnFocus)!, stepButton);
  expect(returnFocus.current).toBe(stepButton);
  const view = capture(() =>
    ThreadView({
      thread: s,
      active: true,
      agents: [],
      onGoSettings: () => {},
      onOpened: () => {},
      artifactReturnFocusRef: returnFocus,
    }),
  );
  expect(
    view.find((node) => node.type === ArtifactPane)!.props.returnFocusRef,
  ).toBe(returnFocus);
  const back = pane(s).find(
    (node) =>
      node.type === "button" && node.props.children === W.showRoundContent,
  )!;
  pointerClick(back);
  expect(returnFocus.current).toBe(stepButton);
  const roundButton = {} as HTMLElement;
  roundClick(s, ended, returnFocus)(roundButton);
  expect(returnFocus.current).toBe(roundButton);
});

it("never substitutes a newer artifact when a captured step reference has expired", () => {
  const s = state();
  round(s, [["/p/shared.md", "EARLIER"]]);
  const original = s.items.find((item) => item.kind === "tool")!;
  expect(toolLink(s, original.id)).toBeDefined();
  const stale = toolLink(s, original.id)!;
  s.items = [];
  round(s, [["/p/shared.md", "NEWER"]]);
  pointerClick(stale);
  expect(html(s)).toContain(W.roundArtifactsUnavailable);
  expect(html(s)).not.toContain("NEWER");
});

it("offers no invented output for an empty command or a location-only read", () => {
  const s = state();
  for (const kind of ["execute", "read"])
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: kind,
      title: kind,
      kind,
      status: "in_progress",
      locations: [{ path: "/p/not-an-artifact.md" }],
    });
  const [command, reading] = s.items.filter((item) => item.kind === "tool");
  expect(toolLink(s, command.id)).toBeUndefined();
  expect(toolLink(s, reading.id)).toBeUndefined();
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "execute",
    rawOutput: "REAL OUTPUT",
  });
  expect(toolLink(s, command.id)).toBeDefined();
  pointerClick(toolLink(s, command.id)!);
  expect(html(s)).toContain("REAL OUTPUT");
  expect(options(s)).toEqual(["output"]);
});

it.each(["file", "output"])(
  "keeps the %s round scope below the content heading and above its controls",
  (kind) => {
    const s = state();
    const current = round(
      s,
      kind === "file" ? [["/p/current.md", "CURRENT"]] : [],
      kind === "output" ? "OUTPUT" : undefined,
    );
    roundClick(s, current)();
    const markup = html(s);
    const heading = markup.indexOf('class="a-head"');
    const scope = markup.indexOf('class="artifact-round-scope"');
    const controls = markup.indexOf('class="artifact-view-toolbar"');
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(scope).toBeGreaterThan(heading);
    expect(controls).toBeGreaterThan(scope);
    expect(markup).toContain(W.allArtifacts);
  },
);

it("opens an empty content pane with a working close action and an honest empty state", () => {
  const s = state();
  threads.openArtifactPane(s.key);
  expect(s.artifactPaneOpen).toBe(true);
  const markup = renderToStaticMarkup(
    <ThreadView
      thread={s}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
  expect(markup).toContain(`aria-label="${W.contentLabel}"`);
  expect(markup).toContain(STRINGS.artifacts.empty);
  const close = pane(s).find((node) => node.props.className === "a-close")!;
  (close.props.onClick as () => void)();
  expect(s.artifactPaneOpen).toBe(false);
});

it("opens the clicked round's multiple files instead of the first historical file", () => {
  const s = state();
  round(s, [["/p/old.md", "OLD-ROUND"]]);
  const current = round(s, [
    ["/p/current.md", "CURRENT-ROUND"],
    ["/p/second.md", "SECOND-CURRENT-FILE"],
  ]);
  roundClick(s, current)();
  expect(picker(s).props.value).toBe("file:/p/current.md");
  expect(options(s)).toEqual(["file:/p/current.md", "file:/p/second.md"]);
  expect(html(s)).toContain("CURRENT-ROUND");
  expect(html(s)).not.toContain("OLD-ROUND");
  select(s, "file:/p/second.md");
  expect(html(s)).toContain("SECOND-CURRENT-FILE");
});

it("shows the old round's version of a shared path without borrowing a later version", () => {
  const s = state();
  const old = round(s, [["/p/shared.md", "EARLIER-VERSION"]]);
  const current = round(s, [["/p/shared.md", "LATER-VERSION"]]);
  roundClick(s, current)();
  expect(html(s)).toContain("LATER-VERSION");
  roundClick(s, old)();
  expect(html(s)).toContain("EARLIER-VERSION");
  expect(html(s)).not.toContain("LATER-VERSION");
  threads.openArtifactPane(s.key);
  expect(html(s)).toContain("LATER-VERSION");
});

it("opens only the clicked round's output when it has no files", () => {
  const s = state();
  round(s, [["/p/old.md", "OLD-FILE"]], "OLDER-OUTPUT");
  const current = round(s, [], "CURRENT-OUTPUT");
  roundClick(s, current)();
  expect(picker(s).props.value).toBe("output");
  expect(options(s)).toEqual(["output"]);
  expect(html(s)).toContain("CURRENT-OUTPUT");
  expect(html(s)).not.toContain("OLDER-OUTPUT");
  expect(html(s)).not.toContain("OLD-FILE");
});

it("preserves the session-wide manual choice through close and round navigation", () => {
  const s = state();
  const old = round(s, [["/p/old.md", "OLD"]]);
  const current = round(s, [["/p/new.md", "NEW"]]);
  threads.openArtifactPane(s.key);
  select(s, "file:/p/new.md");
  threads.closeArtifactPane(s.key);
  expect(s.artifactPaneOpen).toBe(false);
  threads.openArtifactPane(s.key);
  expect(picker(s).props.value).toBe("file:/p/new.md");
  roundClick(s, old)();
  expect(picker(s).props.value).toBe("file:/p/old.md");
  threads.closeArtifactPane(s.key);
  roundClick(s, current)();
  expect(picker(s).props.value).toBe("file:/p/new.md");
  threads.openArtifactPane(s.key);
  expect(options(s)).toEqual(["file:/p/old.md", "file:/p/new.md"]);
  expect(picker(s).props.value).toBe("file:/p/new.md");
});

it("keeps the same path and manual output choice separate across conversations", () => {
  const a = state();
  const aRound = round(a, [["/p/shared.md", "CONVERSATION-A"]], "OUTPUT-A");
  const b = state();
  const bRound = round(b, [["/p/shared.md", "CONVERSATION-B"]]);
  threads.openArtifactPane(a.key);
  select(a, "output");
  roundClick(b, bRound)();
  expect(html(b)).toContain("CONVERSATION-B");
  expect(html(b)).not.toContain("CONVERSATION-A");
  expect(html(a)).toContain("OUTPUT-A");
  roundClick(a, aRound)();
  expect(html(a)).toContain("CONVERSATION-A");
  threads.openArtifactPane(a.key);
  expect(picker(a).props.value).toBe("output");
  expect(html(b)).toContain("CONVERSATION-B");
});

it("does not let a stale round click fall back to different content after replay replaces items", () => {
  const s = state();
  const old = round(s, [["/p/shared.md", "BEFORE-REPLAY"]]);
  const click = roundClick(s, old);
  s.items = [];
  round(s, [["/p/shared.md", "AFTER-REPLAY"]]);
  click();
  expect(html(s)).not.toContain("AFTER-REPLAY");
  expect(html(s)).not.toContain("BEFORE-REPLAY");
  expect(html(s)).toContain("无法定位这次产物");
  threads.openArtifactPane(s.key);
  expect(html(s)).toContain("AFTER-REPLAY");
});

it("keeps a missing round boundary unavailable rather than guessing from a count", () => {
  const s = state();
  round(s, [["/p/unrelated.md", "UNRELATED"]]);
  const missing: Settled = {
    kind: "settled",
    id: `missing-${++serial}`,
    status: "done",
    artifactCount: 1,
    diffCount: 1,
    time: 0,
  };
  s.items.push(missing);
  roundClick(s, missing)();
  expect(html(s)).not.toContain("UNRELATED");
  expect(html(s)).toContain("无法定位这次产物");
});

it("rejects a late picker callback from a different round or the session-wide view", () => {
  const s = state();
  const old = round(s, [["/p/old.md", "OLD"]]);
  const current = round(s, [
    ["/p/one.md", "ONE"],
    ["/p/two.md", "TWO"],
  ]);
  threads.openArtifactPane(s.key);
  const staleAll = picker(s).props.onChange as (event: unknown) => void;
  roundClick(s, old)();
  const staleRound = picker(s).props.onChange as (event: unknown) => void;
  roundClick(s, current)();
  staleAll({ target: { value: "file:/p/two.md" } });
  staleRound({ target: { value: "file:/p/two.md" } });
  expect(picker(s).props.value).toBe("file:/p/one.md");
  expect(html(s)).toContain("ONE");
});

it("keeps late tool results with their original round while a later round stays separate", () => {
  const s = state();
  s.roundItemBase = s.items.length;
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "tail",
    title: "Tail output",
    kind: "execute",
    status: "in_progress",
    rawOutput: "TAIL-PENDING",
  });
  applyTurnEnd(s, { stopReason: "cancelled" });
  const stopped = s.items.at(-1) as Settled;
  const current = round(s, [["/p/next.md", "NEXT-ROUND"]]);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tail",
    status: "completed",
    rawOutput: "TAIL-COMPLETED",
  });
  roundClick(s, current)();
  expect(html(s)).toContain("NEXT-ROUND");
  expect(html(s)).not.toContain("TAIL-COMPLETED");
  roundClick(s, stopped)();
  expect(html(s)).toContain("TAIL-COMPLETED");
  expect(html(s)).not.toContain("NEXT-ROUND");
});

it("reveals the stopped round's entry when its first artifact arrives after the next round", () => {
  const s = state();
  s.running = true;
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "late-file",
    kind: "edit",
    status: "in_progress",
  });
  applyTurnEnd(s, { stopReason: "cancelled" });
  const stopped = s.items.at(-1) as Settled;
  expect(stopped.artifactCount).toBe(0);
  const current = round(s, [["/p/next.md", "NEXT-ROUND"]]);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "late-file",
    status: "completed",
    content: [
      { type: "diff", path: "/p/late.md", oldText: null, newText: "LATE-FILE" },
    ],
  });
  roundClick(s, stopped)();
  expect(options(s)).toEqual(["file:/p/late.md"]);
  expect(html(s)).toContain("LATE-FILE");
  roundClick(s, current)();
  expect(options(s)).toEqual(["file:/p/next.md"]);
});

it("invalidates old range references after a real open replaces the projection, even with a reused tool ID", async () => {
  const s = state();
  const old = round(s, [["/p/shared.md", "OLD-CONTENT"]]);
  const tool = s.items.find((item) => item.kind === "tool")!;
  if (tool.kind !== "tool") throw new Error("expected tool");
  const staleClick = roundClick(s, old);
  roundClick(s, old)();
  s.connectionLost = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    const request = args as {
      channel: { onmessage: (event: unknown) => void };
      openToken: string;
    };
    const result = {
      nativeSessionId: s.nativeSessionId,
      cwd: s.cwd,
      connectionId: `artifact-range-${s.nativeSessionId}`,
      resumed: true,
      configOptions: [],
      warnings: [],
    };
    request.channel.onmessage({
      kind: "sessionOpening",
      openToken: request.openToken,
      cwd: result.cwd,
      sessionId: result.nativeSessionId,
      connectionId: result.connectionId,
    });
    request.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Readable restored history" },
      },
    });
    request.channel.onmessage({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: tool.call.toolCallId,
        kind: "edit",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/p/shared.md",
            oldText: null,
            newText: "RESTORED-CONTENT",
          },
        ],
      },
    });
    request.channel.onmessage({
      kind: "session_history_complete",
      openToken: request.openToken,
    });
    return result;
  });
  const restored = await threads.open({
    agentId: s.agentId,
    cwd: s.cwd,
    nativeSessionId: s.nativeSessionId,
  });
  expect(restored).not.toBe(s);
  expect(restored.artifactPaneOpen).toBe(false);
  staleClick();
  expect(html(restored)).toContain("无法定位这次产物");
  expect(html(restored)).not.toContain("RESTORED-CONTENT");
  threads.openArtifactPane(restored.key);
  expect(html(restored)).toContain("RESTORED-CONTENT");
  expect(restored.running).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith("session_prompt", expect.anything());
});
