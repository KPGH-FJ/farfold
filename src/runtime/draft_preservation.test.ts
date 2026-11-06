import { beforeEach, expect, it, vi } from "vitest";
import type { ComposerDraft, ConversationChoice } from "./drafts";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
beforeEach(() => {
  vi.resetModules();
  mock.invoke.mockReset();
});
const originalChoice: ConversationChoice = {
  agentId: "original-agent",
  cwd: "/original-work",
  reviewRequired: true,
  service: { id: "source", model: "selected-model", revision: "revision-a" },
  config: {
    model: "selected-model",
    thought_level: "high",
    flag: false,
    budget: 2048,
  },
};
function input(): ComposerDraft {
  return {
    text: "保留完整原文\n第二行",
    attachments: [
      {
        id: "picture",
        kind: "image",
        name: "原始图片.png",
        uri: "file:///original/picture.png",
        data: "original-image-data",
        mimeType: "image/png",
        content: "must not trust after restart",
        imageChecked: {
          data: "original-image-data",
          mimeType: "image/png",
          uri: "file:///original/picture.png",
        },
      },
    ],
  };
}
async function setup() {
  mock.invoke.mockImplementation(async (command) =>
    command === "settings_get" ? null : undefined,
  );
  const d = await import("./drafts");
  await d.draftPersistence.load();
  Object.assign(d.newConversationChoice, structuredClone(originalChoice));
  d.composerDrafts.update("new", input);
  await d.draftPersistence.flush();
  return d;
}
function lastWritten() {
  return structuredClone(
    mock.invoke.mock.calls
      .filter(([command]) => command === "settings_set")
      .at(-1)![1].value,
  );
}
it("persists the entire original draft, attachments and choice before the active input can be cleared", async () => {
  const d = await setup();
  const original = d.composerDrafts.read("new");
  const ticket = await d.composerDrafts.preserveNew();
  expect(d.composerDrafts.read("new")).toBe(original);
  const [[key, retained]] = d.composerDrafts.preserved();
  expect(key).toMatch(/^saved-new:/);
  expect(retained).toMatchObject({
    text: original.text,
    attachments: original.attachments,
    savedChoice: originalChoice,
  });
  expect(retained.attachments).not.toBe(original.attachments);
  expect(retained.savedChoice).not.toBe(d.newConversationChoice);
  const written = lastWritten();
  expect(written.composers[key]).toMatchObject({
    text: original.text,
    savedChoice: originalChoice,
  });
  expect(written.composers[key].attachments[0]).not.toHaveProperty(
    "imageChecked",
  );
  expect(written.composers[key].attachments[0]).not.toHaveProperty("content");
  d.composerDrafts.clearPreservedNew(ticket);
  expect(d.composerDrafts.read("new").text).toBe("");
  expect(d.composerDrafts.preserved()[0][1].text).toBe(original.text);
  await d.draftPersistence.flush();
  expect(
    mock.invoke.mock.calls.every(
      ([command]) =>
        command.startsWith("settings_") ||
        command.startsWith("conversation_activity_"),
    ),
  ).toBe(true);
});
it("keeps the active draft and selection when saving the retained copy fails", async () => {
  const d = await setup();
  const original = d.composerDrafts.read("new");
  mock.invoke.mockImplementation(async (command, args) => {
    if (
      command === "settings_set" &&
      Object.keys(args.value.composers).some((key) =>
        key.startsWith("saved-new:"),
      )
    )
      throw new Error("disk full");
  });
  await expect(d.composerDrafts.preserveNew()).rejects.toThrow(
    "未发送内容尚未保存",
  );
  expect(d.composerDrafts.read("new")).toBe(original);
  expect(d.newConversationChoice).toEqual(originalChoice);
  expect(d.composerDrafts.preserved()[0][1].text).toBe(original.text);
  expect(d.draftPersistence.snapshot().error).toBeTruthy();
});
it("retries preservation of the same active draft without leaving a second retained copy", async () => {
  const d = await setup();
  let disk = lastWritten();
  let writable = false;
  mock.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return structuredClone(disk);
    if (command !== "settings_set") return;
    if (!writable) throw new Error("disk full");
    disk = structuredClone(args.value);
  });
  await expect(d.composerDrafts.preserveNew()).rejects.toThrow();
  const [[retainedKey]] = d.composerDrafts.preserved();
  expect(disk.composers[retainedKey]).toBeUndefined();
  expect(d.composerDrafts.read("new").text).toBe(input().text);

  writable = true;
  const ticket = await d.composerDrafts.preserveNew();
  d.composerDrafts.clearPreservedNew(ticket);
  await d.draftPersistence.flush();

  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.composerDrafts.read("new").text).toBe("");
  expect(cold.composerDrafts.preserved()).toEqual([
    [
      retainedKey,
      expect.objectContaining({
        text: input().text,
        savedChoice: originalChoice,
        attachments: [expect.objectContaining({ data: "original-image-data" })],
      }),
    ],
  ]);
});
it("reuses a retained copy when the same active draft returns to its original selection", async () => {
  const d = await setup();
  await d.composerDrafts.preserveNew();
  const [[firstKey]] = d.composerDrafts.preserved();
  d.newConversationChoice.agentId = "other-agent";
  await d.composerDrafts.preserveNew();
  const [, [otherKey]] = d.composerDrafts.preserved();
  d.newConversationChoice.agentId = originalChoice.agentId;
  const ticket = await d.composerDrafts.preserveNew();
  d.composerDrafts.clearPreservedNew(ticket);
  await d.draftPersistence.flush();
  expect(d.composerDrafts.preserved().map(([key]) => key)).toEqual([
    firstKey,
    otherKey,
  ]);
  expect(Object.keys(lastWritten().composers)).toEqual([firstKey, otherKey]);
});
it.each(["editing", "sending", "choice", "clear-generation"])(
  "invalidates the final preservation ticket after %s without clearing the current content",
  async (change) => {
    const d = await setup();
    const ticket = await d.composerDrafts.preserveNew();
    if (change === "editing")
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        text: "newer user edit",
      }));
    if (change === "sending")
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        sendPending: true,
      }));
    if (change === "choice")
      d.newConversationChoice.config = { model: "other-model" };
    if (change === "clear-generation") {
      const original = d.composerDrafts.read("new");
      d.composerDrafts.clear("new");
      d.composerDrafts.update("new", () => original);
    }
    const current = d.composerDrafts.read("new");
    expect(() => d.composerDrafts.clearPreservedNew(ticket)).toThrow();
    expect(d.composerDrafts.read("new")).toBe(current);
    expect(d.composerDrafts.preserved()[0][1].savedChoice).toEqual(
      originalChoice,
    );
    await d.draftPersistence.flush();
  },
);
it("rejects preservation while an input is being sent or an attachment is still loading", async () => {
  const d = await setup();
  d.composerDrafts.update("new", (draft) => ({ ...draft, sendPending: true }));
  await expect(d.composerDrafts.preserveNew()).rejects.toThrow();
  expect(d.composerDrafts.preserved()).toHaveLength(0);
  d.composerDrafts.update("new", (draft) => ({
    ...draft,
    sendPending: false,
    attachments: draft.attachments.map((a) => ({ ...a, loading: true })),
  }));
  await expect(d.composerDrafts.preserveNew()).rejects.toThrow();
  expect(d.composerDrafts.preserved()).toHaveLength(0);
  expect(d.composerDrafts.read("new").text).toBe(input().text);
});
it("restores a retained draft after a cold restart while rechecking images and retaining the displaced draft", async () => {
  const d = await setup();
  const ticket = await d.composerDrafts.preserveNew();
  const key = d.composerDrafts.preserved()[0][0];
  d.composerDrafts.clearPreservedNew(ticket);
  Object.assign(d.newConversationChoice, {
    agentId: "new-agent",
    cwd: "/new-work",
    reviewRequired: false,
    service: null,
    config: { model: "new-model" },
  });
  d.composerDrafts.update("new", () => ({
    text: "另一个未发草稿",
    attachments: [],
  }));
  await d.draftPersistence.flush();
  const written = lastWritten();
  vi.resetModules();
  mock.invoke.mockImplementation(async (command) =>
    command === "settings_get" ? written : undefined,
  );
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.composerDrafts.preserved()[0][1].attachments[0]).toMatchObject({
    recovered: true,
  });
  expect(await cold.composerDrafts.restorePreserved(key)).toBe(true);
  expect(cold.composerDrafts.read("new")).toMatchObject({
    text: input().text,
    attachments: [
      {
        id: "picture",
        kind: "image",
        name: "原始图片.png",
        uri: "file:///original/picture.png",
        data: "original-image-data",
        mimeType: "image/png",
        imageChecked: undefined,
        recovered: true,
      },
    ],
  });
  expect(cold.composerDrafts.read("new").attachments[0]).not.toHaveProperty(
    "content",
  );
  expect(cold.newConversationChoice).toEqual(originalChoice);
  await cold.draftPersistence.flush();
  await vi.waitFor(() =>
    expect(
      cold.composerDrafts.preserved().some(([savedKey]) => savedKey === key),
    ).toBe(false),
  );
  expect(cold.composerDrafts.preserved()).toEqual([
    expect.arrayContaining([
      expect.stringMatching(/^saved-new:/),
      expect.objectContaining({
        text: "另一个未发草稿",
        savedChoice: expect.objectContaining({
          agentId: "new-agent",
          cwd: "/new-work",
        }),
      }),
    ]),
  ]);
  expect(
    mock.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});
it("persists resend drafts across restart and keeps their conversation protected from cleanup", async () => {
  const d = await setup();
  d.composerDrafts.update("resend:existing-conversation", () => ({
    ...input(),
    text: "编辑后追加的文字",
  }));
  expect(d.hasUnsentWork("existing-conversation")).toBe(true);
  expect(d.unsentConversationKeys()).toContain("existing-conversation");
  await d.draftPersistence.flush();
  const written = lastWritten();
  expect(written.composers["resend:existing-conversation"].text).toBe(
    "编辑后追加的文字",
  );
  vi.resetModules();
  mock.invoke.mockImplementation(async (command) =>
    command === "settings_get" ? written : undefined,
  );
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(
    cold.composerDrafts.read("resend:existing-conversation"),
  ).toMatchObject({
    text: "编辑后追加的文字",
    attachments: [{ recovered: true }],
  });
  expect(
    cold.composerDrafts.read("resend:existing-conversation").attachments[0]
      .imageChecked,
  ).toBeUndefined();
  expect(cold.hasUnsentWork("existing-conversation")).toBe(true);
  cold.composerDrafts.clear("resend:existing-conversation");
  expect(cold.hasUnsentWork("existing-conversation")).toBe(false);
  await cold.draftPersistence.flush();
});

it("rejects an in-flight preservation receipt if the user changed the choice while the retained copy was saving", async () => {
  const d = await setup();
  const original = d.composerDrafts.read("new");
  let release: (() => void) | undefined;
  let held = false;
  mock.invoke.mockImplementation(async (command, args) => {
    if (
      command === "settings_set" &&
      !held &&
      Object.keys(args.value.composers).some((key) =>
        key.startsWith("saved-new:"),
      )
    ) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  });
  const result = d.composerDrafts.preserveNew().then(
    () => null,
    (error) => error,
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  d.newConversationChoice.agentId = "later-agent";
  release!();
  expect(await result).toBeInstanceOf(Error);
  expect(d.composerDrafts.read("new")).toBe(original);
  expect(d.newConversationChoice.agentId).toBe("later-agent");
  expect(d.composerDrafts.preserved()[0][1].savedChoice).toEqual(
    originalChoice,
  );
  await d.draftPersistence.flush();
});

it("keeps both retained copies and publishes the matching choice if the final restore save fails", async () => {
  const d = await setup();
  const ticket = await d.composerDrafts.preserveNew();
  const key = d.composerDrafts.preserved()[0][0];
  d.composerDrafts.clearPreservedNew(ticket);
  d.newConversationChoice.agentId = "other-agent";
  d.composerDrafts.update("new", () => ({
    text: "other draft",
    attachments: [],
  }));
  await d.draftPersistence.flush();
  mock.invoke.mockImplementation(async (command, args) => {
    if (
      command === "settings_set" &&
      args.value.composers.new?.text === input().text
    )
      throw new Error("restore write failed");
  });
  expect(await d.composerDrafts.restorePreserved(key)).toBe(true);
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(d.composerDrafts.read("new").text).toBe(input().text);
  expect(d.newConversationChoice).toEqual(originalChoice);
  expect(d.composerDrafts.preserved().map(([, draft]) => draft.text)).toEqual(
    expect.arrayContaining([input().text, "other draft"]),
  );
  expect(
    d.composerDrafts.preserved().some(([savedKey]) => savedKey === key),
  ).toBe(true);
  expect(d.draftPersistence.snapshot().error).toBeTruthy();
});
