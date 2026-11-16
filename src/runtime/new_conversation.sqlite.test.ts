import { expect, it, vi } from "vitest";
import {
  createDraftSqliteFixture,
  draftSqliteAvailable,
} from "./draft_sqlite.test-support";
import { PNG_IMAGE_TEST_DATA } from "./image_fixtures.test-support";
import type { ComposerDraft } from "./drafts";

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mock.invoke,
  Channel: class {},
}));

it.skipIf(!draftSqliteAvailable)(
  "keeps the old first-send safeguards on SQLite BUSY and writes only the original editor on explicit retry",
  async () => {
    const db = createDraftSqliteFixture();
    const agent = "first-send-fixture";
    const cwd = "/first-send-fixture";
    const native = "prepared-id";
    const threadKey = `${agent}:${cwd}:${native}`;
    const siblingKey = "session:independent-saved-draft";
    const sibling = {
      text: "other conversation",
      attachments: [],
      sendPending: false,
    };
    const choice = {
      agentId: agent,
      cwd,
      service: null,
      config: {},
      reviewRequired: false,
    };
    const historical = {
      blocks: [],
      uncertainIndex: null,
      outcomeUnknown: true,
    };
    const uri = "file:///first-send-fixture/notes.txt";
    const original: ComposerDraft = {
      text: "原始未发送内容\n保留第二行",
      attachments: [
        {
          id: "notes",
          kind: "file",
          name: "notes.txt",
          uri,
          deliveryMode: "location",
        },
        {
          id: "png",
          kind: "image",
          name: "image.png",
          data: PNG_IMAGE_TEST_DATA,
          mimeType: "image/png",
        },
      ],
      sendPending: false,
    };
    let releaseRead!: () => void;
    const check = new Promise<void>((resolve) => (releaseRead = resolve));
    let sending: Promise<unknown> | undefined;
    const writes: string[] = [];
    let failure: unknown;
    try {
      db.write({
        version: 1,
        composers: { [siblingKey]: sibling },
        choice,
        feedback: {},
        queues: { [threadKey]: historical },
      });
      mock.invoke.mockImplementation(async (command, args) => {
        if (command === "draft_attachment_check") {
          expect(args).toEqual({ uri, embed: false });
          await check;
          return null;
        }
        expect(args?.key).toBe(db.key);
        if (command === "settings_get") return JSON.parse(db.read() ?? "null");
        expect(command).toBe("settings_set");
        writes.push(JSON.stringify(args.value));
        try {
          db.write(args.value);
        } catch (error) {
          failure = error;
          throw error;
        }
      });
      const { composerDrafts, draftPersistence } = await import("./drafts");
      const { threads } = await import("./sessions");
      const { rememberPendingConversation, finishPendingConversation } =
        await import("./pending_conversation");
      const { sendNewConversation } = await import("./new_conversation");
      const { attachmentPromptBlocks } = await import("./draft_attachments");
      await draftPersistence.load();
      const target = threads.markOpenFailed(
        threadKey,
        agent,
        cwd,
        native,
        "fixture",
      );
      Object.assign(target, {
        identity: "draft",
        openError: null,
        connectionId: "owned-first-connection",
      });
      expect(target.historicalOutcomeUnknown).toBe(true);
      composerDrafts.update("new", () => ({ ...original, sendPending: true }));
      const attempt = await rememberPendingConversation(
        "new",
        composerDrafts.read("new"),
        target,
      );
      const blocks = attachmentPromptBlocks(
        original.text,
        original.attachments,
        true,
      );
      sending = sendNewConversation(threadKey, blocks, attempt).catch(
        (error: unknown) => {
          finishPendingConversation(attempt, "rejected");
          return error;
        },
      );
      await vi.waitFor(() =>
        expect(mock.invoke).toHaveBeenCalledWith("draft_attachment_check", {
          uri,
          embed: false,
        }),
      );
      expect(target.promptSubmission?.dispatched).toBe(false);
      await draftPersistence.flush();
      const before = db.read()!;
      expect(JSON.parse(before)).toMatchObject({
        composers: {
          new: {
            ...original,
            sendPending: true,
            pendingConversation: {
              agentId: agent,
              cwd,
              nativeSessionId: native,
            },
          },
          [siblingKey]: sibling,
        },
        queues: {
          [threadKey]: { ...historical, blocks: [blocks], uncertainIndex: 0 },
        },
      });

      const firstWrite = writes.length;
      const unlock = db.holdWriteLock();
      try {
        threads.pauseQueuesForExit(true);
        await expect(draftPersistence.flush()).rejects.toThrow();
        expect(failure).toMatchObject({ errcode: 5 });
        expect(db.read()).toBe(before);
        expect(composerDrafts.read("new")).toEqual(original);
        expect(target.queued).toEqual([]);
        releaseRead();
        expect(await sending).toBeInstanceOf(Error);
        expect(writes.slice(firstWrite)).toHaveLength(1);
        expect(db.read()).toBe(before);
        expect(draftPersistence.snapshot().error).toBeTruthy();
      } finally {
        unlock();
      }

      expect(db.read()).toBe(before);
      await draftPersistence.flush();
      const after = db.read()!;
      expect(writes.slice(firstWrite)).toEqual([after, after]);
      const saved = JSON.parse(after);
      expect(saved.composers).toEqual({ new: original, [siblingKey]: sibling });
      expect(saved.queues).toEqual({ [threadKey]: historical });
      expect(saved.choice).toEqual(choice);

      vi.resetModules();
      const cold = await import("./drafts");
      const { threads: coldThreads } = await import("./sessions");
      expect(coldThreads.getSnapshot().threads.size).toBe(0);
      await cold.draftPersistence.load();
      expect(cold.composerDrafts.read("new")).toMatchObject(original);
      expect(
        cold.composerDrafts.read("new").pendingConversation,
      ).toBeUndefined();
      expect(cold.composerDrafts.read(siblingKey)).toMatchObject(sibling);
      const restored = coldThreads.markOpenFailed(
        threadKey,
        agent,
        cwd,
        native,
        "cold fixture",
      );
      expect(restored).toMatchObject({
        historicalOutcomeUnknown: true,
        queued: [],
        uncertainPrompt: null,
      });
      await cold.draftPersistence.flush();
      expect(db.read()).toBe(after);
      expect(writes.slice(firstWrite)).toHaveLength(2);
      expect(
        mock.invoke.mock.calls.filter(
          ([command]) => command === "draft_attachment_check",
        ),
      ).toHaveLength(1);
      expect(
        new Set(mock.invoke.mock.calls.map(([command]) => command)),
      ).toEqual(
        new Set(["settings_get", "settings_set", "draft_attachment_check"]),
      );
    } finally {
      try {
        releaseRead();
        await sending;
      } finally {
        db.close();
      }
    }
  },
);
