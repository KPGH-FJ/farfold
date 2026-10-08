import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  resetHarness,
} from "./App.test-harness";
import { invoke } from "@tauri-apps/api/core";

beforeEach(resetHarness);
afterEach(() => {
  cleanupHarness();
  vi.mocked(invoke).mockImplementation(async () => "/ordinary");
});

it.each(["library", "conversation", "message"] as const)(
  "keeps changed API settings unconfirmed when starting from %s",
  async (entry) => {
    const row = {
      id: "old-A",
      agentId: "A",
      cwd: "/old-A",
      nativeSessionId: "old-A",
      configOptions: {
        _farfoldConfig: 2,
        choices: [{ id: "reasoning", value: "ultra" }],
        _farfoldService: {
          kind: "configured",
          identity: { id: "api", model: "m", fingerprint: "original-source" },
        },
      },
    };
    h.index = [row];
    h.draft = { text: "", attachments: [] };
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        id: "api",
        label: "Same name",
        endpoint: "https://changed.test",
        apiType: "responses",
        models: ["m"],
        fingerprint: "changed-source",
        revision: "changed-revision",
        complete: true,
        deleting: false,
        grants: [],
      },
    ]);
    if (entry === "library") call("ConversationLibrary", "onReopen", row);
    else {
      call("ConversationLibrary", "onOpen", row);
      if (entry === "conversation") call("ThreadPage", "onReopenSame", row);
      else
        call("ThreadPage", "onNewFromMessage", h.threads.get("old-A"), {
          text: "Keep this message",
          attachments: [],
        });
    }
    await vi.waitFor(() => {
      expect(component("EmptyState").active).toBe(true);
      expect(component("EmptyState").initialSelection).toEqual({
        service: { id: "api", model: "m", revision: "" },
        config: { reasoning: "ultra" },
      });
    });
    expect(h.choice.cwd).toBe("/old-A");
    expect(h.draft.text).toBe(entry === "message" ? "Keep this message" : "");
    expect(h.open).not.toHaveBeenCalled();
  },
);
