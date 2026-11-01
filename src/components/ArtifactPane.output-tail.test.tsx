import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { ArtifactPane } from "./ArtifactPane";
import { appendToolOutput, COMMAND_OUTPUT_CAP } from "../runtime/artifacts";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";
import { STRINGS } from "../runtime/strings";
import { ARTIFACT_OUTPUT as O } from "../runtime/artifact_output_strings";

function renderOutput(output: string, streamed = false, kind = "execute") {
  const thread = freshThreadState(
    "output-tail",
    "agent",
    "/synthetic",
    "native",
  );
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "tail",
    title: "Output tail",
    kind,
    status: "completed",
    rawOutput: streamed ? "unused raw output" : output,
    content: [{ type: "terminal", terminalId: "owned-terminal" }],
  });
  if (streamed)
    appendToolOutput(thread, {
      toolCallId: "tail",
      terminalId: "owned-terminal",
      data: output,
    });
  const before = structuredClone(thread.items);
  const html = renderToStaticMarkup(<ArtifactPane thread={thread} active />);
  expect(thread.items).toEqual(before);
  return { html, text: html.match(/<pre class="a-term">(.*?)<\/pre>/s)?.[1] };
}

for (const kind of ["execute", "read"])
  for (const streamed of [false, true]) {
    const label = `${kind} ${streamed ? "streamed" : "reported"}`;
    it(`${label}: keeps the clipping notice when a boundary pair shortens the retained tail`, () => {
      const tail = "x".repeat(COMMAND_OUTPUT_CAP - 1);
      const { html, text } = renderOutput("🙂" + tail, streamed, kind);
      expect(text).toBe(tail);
      expect(html).toContain(STRINGS.artifacts.terminalTruncated);
    });

    it(`${label}: does not describe an exactly full, uncut result as truncated`, () => {
      const output = "🙂" + "x".repeat(COMMAND_OUTPUT_CAP - 2);
      const { html, text } = renderOutput(output, streamed, kind);
      expect(text).toBe(output);
      expect(html).not.toContain(STRINGS.artifacts.terminalTruncated);
    });
  }

it("still explains the separate line limit for a result below the text limit", () => {
  const lines = Array.from({ length: 201 }, (_, i) => `line-${i}`);
  const { html, text } = renderOutput(lines.join("\n"));
  expect(text).toBe(lines.slice(1).join("\n"));
  expect(html).toContain(STRINGS.artifacts.terminalTruncated);
});

it("distinguishes missing reported chunks from local head clipping without rewriting the tool", () => {
  const thread = freshThreadState(
    "reported-gap",
    "agent",
    "/synthetic",
    "native",
  );
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "reported",
    kind: "other",
    status: "in_progress",
  });
  appendToolOutput(thread, {
    source: "reported",
    toolCallId: "reported",
    data: "RECEIVED&lt;🙂\n",
    sequence: 2,
    truncated: true,
  });
  const before = structuredClone(thread.items);
  const html = renderToStaticMarkup(<ArtifactPane thread={thread} active />);
  expect(html).toContain(O.incomplete);
  expect(html).not.toContain(STRINGS.artifacts.terminalTruncated);
  expect(html).toContain("RECEIVED&amp;lt;🙂");
  expect(thread.items).toEqual(before);
});
