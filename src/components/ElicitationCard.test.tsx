import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ElicitationCard } from "./ElicitationCard";
import type { PendingElicitation } from "../runtime/session_types";

it("renders each request's saved values and keeps an uncertain reply read-only", () => {
  const first: PendingElicitation = {
    requestId: "first",
    status: "pending",
    error: null,
    toolCallId: null,
    message: "First question",
    values: { answer: "first answer" },
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  };
  const render = (request: PendingElicitation) =>
    renderToStaticMarkup(
      <ElicitationCard
        request={request}
        onChange={() => {}}
        onRespond={() => {}}
      />,
    );
  expect(render(first)).toContain('value="first answer"');
  const second = render({
    ...first,
    requestId: "second",
    message: "Second question",
    values: { answer: "second answer" },
    status: "uncertain",
    error: "回复结果未知",
  });
  expect(second).toContain('value="second answer"');
  expect(second).not.toContain("first answer");
  expect(second).toContain('<fieldset class="el-form" disabled=""');
  expect(second).toContain("回复结果未知");
});

it("keeps the same pending answer visible but disables the form and all actions during stop confirmation", () => {
  const request: PendingElicitation = {
    requestId: "stop-question",
    status: "pending",
    error: null,
    toolCallId: null,
    message: "Keep question",
    schema: { type: "object", properties: { answer: { type: "string" } } },
    values: { answer: "Keep unsent answer" },
  };
  const html = renderToStaticMarkup(
    <ElicitationCard
      request={request}
      disabled
      onChange={() => {}}
      onRespond={() => {}}
    />,
  );
  expect(html).toContain('value="Keep unsent answer"');
  expect(html).toContain('<fieldset class="el-form" disabled=""');
  expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  expect(request.status).toBe("pending");
});
