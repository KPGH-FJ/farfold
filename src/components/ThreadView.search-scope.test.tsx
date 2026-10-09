import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
// Only the pane leaf is replaced: exercise the actual ThreadView context
// boundary with a shared folded renderer so future reuse cannot leak scope.
vi.mock("./ArtifactPane", () => ({
  ArtifactPane: () => (
    <aside data-search-active={useTranscriptSearchActive()}>
      <DiffView
        path="/pane"
        oldText={null}
        newText={Array.from({ length: 60 }, (_, i) =>
          i === 50 ? "pane-tail-must-stay-unmounted" : `pane-${i}`,
        ).join("\n")}
      />
    </aside>
  ),
}));
import { invoke } from "@tauri-apps/api/core";
import {
  TranscriptSearchContext,
  useTranscriptSearchActive,
} from "./transcript-search";
import { DiffView } from "./thread-items";
import { ThreadView } from "./ThreadView";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";

it("limits find materialization to the transcript and keeps the content pane outside search", () => {
  // Module initialization reads only the existing performance time origin;
  // measure calls caused by rendering this scenario separately.
  vi.mocked(invoke).mockClear();
  const thread = freshThreadState(
    "search-scope",
    "fixture",
    "/synthetic",
    "native",
  );
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    title: "step",
    kind: "edit",
    status: "completed",
    content: [
      {
        type: "diff",
        path: "/body",
        oldText: null,
        newText: Array.from({ length: 60 }, (_, i) =>
          i === 50 ? "transcript-tail-is-searchable" : `body-${i}`,
        ).join("\n"),
      },
    ],
  });
  const html = renderToStaticMarkup(
    <TranscriptSearchContext.Provider value={true}>
      <ThreadView
        thread={thread}
        active
        agents={[]}
        onGoSettings={() => {}}
        onOpened={() => {}}
      />
    </TranscriptSearchContext.Provider>,
  );
  expect(html).toContain("transcript-tail-is-searchable");
  expect(html).toContain('data-search-active="false"');
  expect(html).not.toContain("pane-tail-must-stay-unmounted");
  expect(invoke).not.toHaveBeenCalled();
});
