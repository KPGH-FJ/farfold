import { describe, expect, it } from "vitest";
import { applyUpdate, freshThreadState } from "./session_projection";
import {
  attachmentMedia,
  hasReadableMessages,
  normalizeMessageAttachment,
} from "./message_attachments";

describe("declared message attachments", () => {
  it.each([
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
    { type: "resource_link", name: "notes.md", uri: "file:///notes.md" },
    {
      type: "resource",
      resource: {
        uri: "file:///notes.md",
        text: "Actual notes",
        mimeType: "text/plain",
      },
    },
    {
      type: "resource",
      resource: {
        uri: "file:///report.pdf",
        blob: "cGRm",
        mimeType: "application/pdf",
      },
    },
  ])(
    "retains an attachment-only user or Agent replay as actual message content: $type",
    (content) => {
      for (const role of ["user", "agent"]) {
        const state = freshThreadState("k", "a", "/work", "id");
        applyUpdate(state, { sessionUpdate: `${role}_message_chunk`, content });
        expect(hasReadableMessages(state.items)).toBe(true);
        expect(state.items[0]).toMatchObject({
          kind: role,
          text: "",
          attachments: [normalizeMessageAttachment(content)],
        });
        applyUpdate(state, {
          sessionUpdate: `${role}_message_chunk`,
          content: { type: "text", text: "caption" },
        });
        expect(state.items).toHaveLength(1);
        expect(state.items[0]).toMatchObject({ text: "caption" });
      }
    },
  );
  it.each([
    { type: "image", data: "" },
    { type: "audio", mimeType: "audio/wav" },
    { type: "resource_link", name: "unverified" },
    { type: "resource", resource: { uri: "file:///missing-payload" } },
    { type: "future", text: "arbitrary envelope is not message text" },
  ])(
    "preserves unsupported or incomplete content as raw without approving history: $type",
    (content) => {
      const state = freshThreadState("k", "a", "/work", "id");
      applyUpdate(state, { sessionUpdate: "agent_message_chunk", content });
      expect(state.items[0]).toMatchObject({ kind: "raw", update: content });
      expect(hasReadableMessages(state.items)).toBe(false);
    },
  );
  it("only embeds safe media data, with no automatic network or active document load", () => {
    expect(
      attachmentMedia({
        name: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
      }),
    ).toEqual({ kind: "image", src: "data:image/png;base64,aW1hZ2U=" });
    expect(
      attachmentMedia({
        name: "remote",
        uri: "https://example.com/image.png",
        mimeType: "image/png",
      }),
    ).toBeNull();
    expect(
      attachmentMedia({
        name: "script",
        data: "c2NyaXB0",
        mimeType: "image/svg+xml",
      }),
    ).toBeNull();
    expect(
      attachmentMedia({
        name: "invalid",
        data: "<script>",
        mimeType: "image/png",
      }),
    ).toBeNull();
  });
  it("deduplicates exact optimistic attachment echoes without conflating another image", () => {
    const state = freshThreadState("k", "a", "/work", "id");
    const content = { type: "image", data: "b25l", mimeType: "image/png" };
    state.items.push({
      kind: "user",
      id: "local",
      text: "",
      attachments: [normalizeMessageAttachment(content)!],
      streaming: false,
      time: 1,
    });
    applyUpdate(state, { sessionUpdate: "user_message_chunk", content });
    expect(state.items).toHaveLength(1);
    applyUpdate(state, {
      sessionUpdate: "user_message_chunk",
      content: { ...content, data: "dHdv" },
    });
    expect(state.items).toHaveLength(2);
  });
});
