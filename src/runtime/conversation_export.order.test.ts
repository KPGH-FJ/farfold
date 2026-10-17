import { expect, it } from "vitest";
import { transcriptMarkdown } from "./conversation_export";
import { applyUpdate, freshThreadState } from "./session_projection";

it("keeps an Agent attachment description between its surrounding text in export", () => {
  const state = freshThreadState("order-export", "chosen", "/owned", "id");
  for (const content of [
    { type: "text", text: "EXPORT_BEFORE\n\n" },
    {
      type: "resource_link",
      name: "ORDER_MEDIA",
      uri: "https://example.test/asset.png?token=EXCLUDED_TOKEN",
      mimeType: "image/png",
    },
    { type: "text", text: "EXPORT_AFTER" },
  ])
    applyUpdate(state, { sessionUpdate: "agent_message_chunk", content });
  const before = JSON.stringify(state.items);
  const markdown = transcriptMarkdown(state, "Current", "Chosen");
  expect(markdown.indexOf("EXPORT_BEFORE")).toBeLessThan(
    markdown.indexOf("ORDER"),
  );
  expect(markdown.indexOf("ORDER")).toBeLessThan(
    markdown.indexOf("EXPORT_AFTER"),
  );
  expect(markdown).not.toContain("EXCLUDED_TOKEN");
  expect(JSON.stringify(state.items)).toBe(before);
});

it("does not hide legacy text or attachment descriptions for incomplete order", () => {
  const state = freshThreadState("order-export", "chosen", "/owned", "id");
  state.items.push({
    kind: "agent",
    id: "legacy",
    text: "LEGACY_EXPORT_BODY",
    attachments: [
      { name: "LEGACY_EXPORT_ATTACHMENT", text: "Not an export payload" },
    ],
    contentOrder: [{ kind: "text", start: 0, end: 4 }],
    streaming: false,
    time: 1,
  });
  const markdown = transcriptMarkdown(state, "Current", "Chosen");
  expect(markdown).toContain("LEGACY_EXPORT_BODY");
  expect(markdown).toContain("LEGACY");
  expect(markdown).not.toContain("Not an export payload");
});
