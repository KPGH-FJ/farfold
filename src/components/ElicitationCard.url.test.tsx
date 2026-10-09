import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ElicitationCard } from "./ElicitationCard";
import type { PendingElicitation } from "../runtime/session_types";

it("shows the full URL and target host separately from form input", () => {
  const request = {
    requestId: "url-request",
    mode: "url",
    url: "https://example.test/connect?step=review",
    elicitationId: "opaque",
    message: "Review https://other.test/ as plain text",
    schema: null,
    toolCallId: null,
    values: {},
    status: "pending",
    error: null,
  } as PendingElicitation;
  const html = renderToStaticMarkup(
    <ElicitationCard
      request={request}
      onChange={() => {}}
      onRespond={() => {}}
    />,
  );
  expect(html).toContain("https://example.test/connect?step=review");
  expect(html).toContain("example.test");
  expect(html).not.toContain("<fieldset");
  expect(html).not.toContain("href=");
  expect(html).toContain("同意并打开");
  expect(html).toContain("拒绝");
  expect(html).toContain("取消");
});
