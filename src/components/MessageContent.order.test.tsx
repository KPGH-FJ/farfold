import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageContent } from "./MessageContent";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";

const image = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgo=",
  uri: "file:///owned/order-first.png",
};

function renderChunks(contents: unknown[]): string {
  const state = freshThreadState("media-order", "chosen", "/owned", "id");
  for (const content of contents) {
    applyUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      messageId: "same-official-message",
      content,
    });
  }
  expect(state.items).toHaveLength(1);
  const item = state.items[0];
  if (item.kind !== "agent") throw Error("Expected the declared Agent message");
  const props = {
    source: item,
    text: item.text,
    attachments: item.attachments,
    contentOrder: item.contentOrder,
  };
  return renderToStaticMarkup(<MessageContent {...props} />);
}

it("keeps received image before the following caption in the same message", () => {
  const html = renderChunks([
    image,
    { type: "text", text: "ORDER_CAPTION_AFTER_IMAGE" },
  ]);
  expect(html.indexOf(image.uri)).toBeGreaterThan(-1);
  expect(html.indexOf(image.uri)).toBeLessThan(
    html.indexOf("ORDER_CAPTION_AFTER_IMAGE"),
  );
  expect(html).not.toContain("<img");
});

it("parses adjacent Markdown text chunks together and exposes each original attachment index", () => {
  const html = renderChunks([
    { type: "text", text: "**MARKDOWN_" },
    { type: "text", text: "TOGETHER**" },
    image,
    { type: "text", text: "Between" },
    { ...image, uri: "file:///owned/order-second.png" },
  ]);
  expect(html).toContain("<strong>MARKDOWN_TOGETHER</strong>");
  expect(html.match(/data-loaded-body/g)).toHaveLength(1);
  expect(html).toContain('data-loaded-attachment="0"');
  expect(html).toContain('data-loaded-attachment="1"');
  expect(html.indexOf(image.uri)).toBeLessThan(html.indexOf("Between"));
  expect(html.indexOf("Between")).toBeLessThan(
    html.indexOf("file:///owned/order-second.png"),
  );
});

it("retains all legacy content if supplied order metadata is incomplete", () => {
  const source = {};
  const html = renderToStaticMarkup(
    <MessageContent
      source={source}
      text="Full legacy body"
      attachments={[
        { name: "Legacy attachment", text: "Full attachment body" },
      ]}
      contentOrder={[{ kind: "text", start: 0, end: 4 }]}
    />,
  );
  expect(html).toContain("Full legacy body");
  expect(html).toContain("Full attachment body");
});

it("keeps an embedded media between the surrounding received text", () => {
  const html = renderChunks([
    { type: "text", text: "ORDER_TEXT_BEFORE\n\n" },
    image,
    { type: "text", text: "ORDER_TEXT_AFTER" },
  ]);
  expect(html.indexOf("ORDER_TEXT_BEFORE")).toBeLessThan(
    html.indexOf(image.uri),
  );
  expect(html.indexOf(image.uri)).toBeLessThan(
    html.indexOf("ORDER_TEXT_AFTER"),
  );
  expect(html).not.toContain("<img");
});
