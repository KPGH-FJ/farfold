import { afterEach, expect, it } from "vitest";
import { composerDrafts } from "./drafts";

afterEach(() => {
  composerDrafts.clear("new");
  composerDrafts.clear("session:a");
  composerDrafts.clear("session:b");
});

it("retains text and attachments independently when switching between new and existing conversations", () => {
  composerDrafts.update("new", () => ({
    text: "Trip notes",
    attachments: [
      { id: "file", kind: "file", name: "notes.md", uri: "file:///notes.md" },
    ],
  }));
  composerDrafts.update("session:a", () => ({
    text: "Follow up",
    attachments: [],
  }));
  expect(composerDrafts.read("session:b").text).toBe("");
  expect(composerDrafts.read("new").attachments[0].name).toBe("notes.md");
  expect(composerDrafts.read("session:a").text).toBe("Follow up");
});

it("a delayed successful send clears only its original input and cannot erase a newer draft", () => {
  composerDrafts.update("session:a", () => ({
    text: "First",
    attachments: [],
  }));
  const sent = composerDrafts.read("session:a");
  composerDrafts.update("session:a", () => ({
    text: "New thought",
    attachments: [],
  }));
  composerDrafts.clearIfUnchanged("session:a", sent);
  expect(composerDrafts.read("session:a").text).toBe("New thought");
  composerDrafts.clearIfUnchanged(
    "session:a",
    composerDrafts.read("session:a"),
  );
  expect(composerDrafts.read("session:a").text).toBe("");
});

it("invalidates a pending file dialog after its draft was sent, without affecting other conversations", () => {
  const dialogGeneration = composerDrafts.generation("new");
  const otherGeneration = composerDrafts.generation("session:b");
  composerDrafts.clear("new");
  expect(composerDrafts.generation("new")).not.toBe(dialogGeneration);
  expect(composerDrafts.generation("session:b")).toBe(otherGeneration);
});

it("appends file feedback only to its conversation while retaining text and attachments", async () => {
  const { appendConversationFeedback } = await import("./drafts");
  const attachment = {
    id: "file",
    kind: "file" as const,
    name: "notes.md",
    uri: "file:///notes.md",
  };
  composerDrafts.update("session:a", () => ({
    text: "Existing thought",
    attachments: [attachment],
  }));
  composerDrafts.update("session:b", () => ({
    text: "Other conversation",
    attachments: [],
  }));
  appendConversationFeedback("a", "  关于 notes.md：\nPlease shorten this.  ");
  expect(composerDrafts.read("session:a")).toEqual({
    text: "Existing thought\n\n关于 notes.md：\nPlease shorten this.",
    attachments: [attachment],
  });
  expect(composerDrafts.read("session:b").text).toBe("Other conversation");
  expect(composerDrafts.read("new").text).toBe("");
});
