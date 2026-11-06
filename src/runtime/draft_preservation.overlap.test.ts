import { beforeEach, expect, it, vi } from "vitest";
import type { ComposerDraft, ConversationChoice } from "./drafts";
import { REDESIGN } from "./redesign_strings";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});

const key = "saved-new:fixture";
const activeChoice: ConversationChoice = {
  agentId: "current-agent",
  cwd: "/fixture/current",
  service: null,
  config: {},
};
const retained: ComposerDraft = {
  text: "retained draft",
  attachments: [
    {
      id: "retained-file",
      kind: "file",
      name: "retained.txt",
      uri: "file:///fixture/retained.txt",
      deliveryMode: "location",
    },
  ],
  savedChoice: {
    ...activeChoice,
    agentId: "retained-agent",
    cwd: "/fixture/retained",
  },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["later input", "later choice", "another conversation"] as const)(
  "keeps %s when a retained-draft restore waits for an earlier save",
  async (change) => {
    const started = deferred();
    const release = deferred();
    const beforeText = change === "later choice" ? "" : "active draft";
    let disk: unknown = {
      version: 1,
      composers: {
        [key]: retained,
        ...(beforeText ? { new: { text: beforeText, attachments: [] } } : {}),
      },
      choice: activeChoice,
      feedback: {},
      queues: {},
    };
    let writes = 0;
    h.invoke.mockImplementation(
      async (command: string, args: { key: string; value?: unknown }) => {
        expect(args.key).toBe("unsentWork.v1");
        if (command === "settings_get") return structuredClone(disk);
        expect(command).toBe("settings_set");
        if (++writes === 1) {
          started.resolve();
          await release.promise;
        }
        disk = structuredClone(args.value);
      },
    );
    const d = await import("./drafts");
    await d.draftPersistence.load();
    d.newConversationChoice.config = { thinking: true };
    await started.promise;

    const restoring = Promise.allSettled([
      d.composerDrafts.restorePreserved(key),
    ]);
    if (change === "later input") {
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        text: "newer unsent input",
      }));
    } else if (change === "later choice") {
      d.newConversationChoice.agentId = "newer-agent";
    } else {
      d.composerDrafts.update("session:other", () => ({
        text: "unrelated unsent input",
        attachments: [],
      }));
    }
    release.resolve();
    const [result] = await restoring;
    await d.draftPersistence.flush();

    if (change === "another conversation") {
      expect(result).toEqual({ status: "fulfilled", value: true });
      expect(d.composerDrafts.read("new").text).toBe(retained.text);
      expect(d.composerDrafts.read("session:other").text).toBe(
        "unrelated unsent input",
      );
      expect(
        d.composerDrafts.preserved().map(([, draft]) => draft.text),
      ).toEqual([beforeText]);
      return;
    }
    const text = change === "later input" ? "newer unsent input" : "";
    const agentId =
      change === "later choice" ? "newer-agent" : activeChoice.agentId;
    expect(d.composerDrafts.read("new").text).toBe(text);
    expect(d.newConversationChoice.agentId).toBe(agentId);
    expect(result).toMatchObject({
      status: "rejected",
      reason: { message: REDESIGN.draftChanged },
    });

    vi.resetModules();
    const cold = await import("./drafts");
    await cold.draftPersistence.load();
    expect(cold.composerDrafts.read("new").text).toBe(text);
    expect(cold.newConversationChoice.agentId).toBe(agentId);
    expect(cold.composerDrafts.preserved()).toHaveLength(1);
    expect(cold.composerDrafts.preserved()[0]).toMatchObject([key, retained]);
  },
);
