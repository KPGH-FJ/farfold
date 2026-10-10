import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { applyUpdate, freshThreadState } from "./runtime/session_projection";
import {
  searchLoadedConversations,
  loadedMarkdownFields,
} from "./runtime/loaded_search";
import { browserSurfaceGuard } from "./runtime/browser_surface";

beforeEach(resetHarness);
afterEach(cleanupHarness);
async function fixture() {
  const state = freshThreadState("loaded", "A", "/controlled", "native");
  state.connectionLost = true;
  applyUpdate(state, {
    sessionUpdate: "agent_message_chunk",
    messageId: "m",
    content: { type: "text", text: "Retained visible body" },
  });
  h.threads.set(state.key, state);
  h.index = [
    {
      id: state.key,
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: state.nativeSessionId,
    },
  ];
  const hit = (
    await searchLoadedConversations(
      [state.key],
      new Map([[state.key, state]]),
      "visible",
      {
        yieldControl: async () => {},
        parseMarkdown: async (text: string) => loadedMarkdownFields(text),
      },
    )
  ).hits[0];
  return { state, hit };
}
it("selects the already loaded exact message without restoring a disconnected Agent", async () => {
  const { hit } = await fixture();
  call("ConversationLibrary", "onSelectLoaded", hit, () => true);
  expect(component("ThreadPage")).toMatchObject({
    viewKey: "loaded",
    searchRequest: { hit },
  });
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
  expect(h.draft.text).toBe("OWN-ORIGINAL-DRAFT");
});
it.each(["query", "message", "index"])(
  "rechecks %s after a delayed browser close instead of opening cold history",
  async (change) => {
    const { hit, state } = await fixture();
    let accept = true;
    let finish!: () => void;
    const close = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = browserSurfaceGuard.register(() => close);
    try {
      call("ConversationLibrary", "onSelectLoaded", hit, () => accept);
      if (change === "query") accept = false;
      if (change === "message") state.items = [];
      if (change === "index") h.index = [];
      finish();
      await vi.waitFor(() =>
        expect(browserSurfaceGuard.getSnapshot().busy).toBe(false),
      );
      expect(render().some((node) => node.props.viewKey === "loaded")).toBe(
        false,
      );
      expect(h.open).not.toHaveBeenCalled();
      expect(h.reconnect).not.toHaveBeenCalled();
    } finally {
      release.release();
    }
  },
);
it("checks state again after a callback changes the exact source synchronously", async () => {
  const { hit } = await fixture();
  call("ConversationLibrary", "onSelectLoaded", hit, () => {
    h.threads.delete("loaded");
    return true;
  });
  expect(render().some((node) => node.props.viewKey === "loaded")).toBe(false);
  expect(h.open).not.toHaveBeenCalled();
});
