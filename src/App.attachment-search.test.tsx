import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { freshThreadState } from "./runtime/session_projection";
import { attachmentSearchCandidates } from "./runtime/attachment_search_source";
import { browserSurfaceGuard } from "./runtime/browser_surface";
beforeEach(resetHarness);
afterEach(cleanupHarness);
function fixture() {
  const state = freshThreadState("loaded", "A", "/controlled", "native");
  state.connectionLost = true;
  state.items = [
    {
      kind: "user",
      id: "message",
      text: "ordinary",
      attachments: [
        { name: "current.txt", uri: "file:///controlled/current.txt" },
      ],
      streaming: false,
      time: 0,
    },
  ];
  h.threads.set(state.key, state);
  h.index = [
    {
      id: state.key,
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: state.nativeSessionId,
    },
  ];
  return {
    state,
    source: attachmentSearchCandidates(
      [state.key],
      new Map([[state.key, state]]),
    ).candidates[0],
  };
}
it("opens only the already loaded source attachment without Agent recovery", () => {
  const { source } = fixture();
  call("ConversationLibrary", "onSelectAttachment", source, () => true);
  expect(component("ThreadPage")).toMatchObject({
    viewKey: "loaded",
    attachmentSearchRequest: { source },
  });
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
  expect(h.draft.text).toBe("OWN-ORIGINAL-DRAFT");
});
it("hands the exact verified PDF page intent to the loaded owner without opening a preview", () => {
  const { source } = fixture();
  const pdfPreview = {
    file: {
      root: "/controlled",
      path: "/controlled/current.txt",
      resolvedPath: "/controlled/current.txt",
      name: "current.txt",
      size: 10,
      sha256: "controlled",
      version: "v1",
    },
    pageNumber: 2,
  };
  call(
    "ConversationLibrary",
    "onSelectAttachment",
    source,
    () => true,
    pdfPreview,
  );
  expect(component("ThreadPage").attachmentSearchRequest).toMatchObject({
    source,
    pdfPreview,
  });
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
});
it.each(["owner", "message", "index", "thread"])(
  "rejects stale %s after browser hide before attachment navigation",
  async (change) => {
    const { state, source } = fixture();
    let current = true,
      finish!: () => void;
    const close = new Promise<void>((r) => {
      finish = r;
    });
    const owned = browserSurfaceGuard.register(() => close);
    try {
      call("ConversationLibrary", "onSelectAttachment", source, () => current);
      if (change === "owner") current = false;
      if (change === "message") state.items = [];
      if (change === "index") h.index = [];
      if (change === "thread") h.threads.delete(state.key);
      finish();
      await vi.waitFor(() =>
        expect(browserSurfaceGuard.getSnapshot().busy).toBe(false),
      );
      expect(render().some((n) => n.props.viewKey === "loaded")).toBe(false);
      expect(h.open).not.toHaveBeenCalled();
      expect(h.reconnect).not.toHaveBeenCalled();
    } finally {
      owned.release();
    }
  },
);
it("does not accept an invented message offset or fabricated source", () => {
  const { source } = fixture();
  call("ConversationLibrary", "onSelectAttachment", { ...source }, () => true);
  expect(render().some((n) => n.props.viewKey === "loaded")).toBe(false);
  expect(h.open).not.toHaveBeenCalled();
});

it("clears the old attachment jump when ordinary navigation leaves and returns", () => {
  const { source } = fixture();
  call("ConversationLibrary", "onSelectAttachment", source, () => true);
  expect(component("ThreadPage").attachmentSearchRequest).toBeTruthy();
  call("Sidebar", "onLibrary", { kind: "all" });
  expect(component("ThreadPage").attachmentSearchRequest).toBeNull();
});
