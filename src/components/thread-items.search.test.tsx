import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { ToolCallView } from "../runtime/session_types";
import { DiffView, PlanBlock, RawBlock, ToolStep } from "./thread-items";
import { TranscriptSearchContext } from "./transcript-search";
import { ReportedDetails } from "./ReportedDetails";

const call: ToolCallView = {
  toolCallId: "search-tool",
  title: "tool-title-needle",
  kind: "execute",
  status: "completed",
  startedAt: 1,
  endedAt: 2,
  locations: [{ path: "/work/location-needle", line: 9 }],
  content: [{ type: "text", text: "folded-body-needle" }],
  rawInput: { command: "command-needle", cwd: "/work/cwd-needle" },
  rawOutput: "output-needle",
};

function render(node: ReactNode, active = true) {
  return renderToStaticMarkup(
    <TranscriptSearchContext.Provider value={active}>
      {node}
    </TranscriptSearchContext.Provider>,
  );
}

it("materializes folded tool text for search without visibly opening or navigating", () => {
  const onOpenFile = vi.fn();
  const html = render(<ToolStep call={call} onOpenFile={onOpenFile} />);
  expect(html).toContain("folded-body-needle");
  expect(html).toMatch(/hidden=""[^>]*>[\s\S]*class="step-detail"/);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toMatch(/data-find-block="true"[^>]*>folded-body-needle/);
  expect(onOpenFile).not.toHaveBeenCalled();
});

it("keeps closed tool bodies unmounted outside search", () => {
  const html = render(<ToolStep call={call} />, false);
  expect(html).not.toContain("folded-body-needle");
  expect(html).not.toContain("output-needle");
});

it("registers tool fields separately while leaving action labels outside the text blocks", () => {
  const html = render(<ToolStep call={call} />);
  for (const text of [
    "tool-title-needle",
    "command-needle",
    "/work/cwd-needle",
    "output-needle",
  ]) {
    expect(html).toMatch(new RegExp(`data-find-block="true"[^>]*>${text}`));
  }
  expect(html).not.toMatch(/<button[^>]*data-find-block/);
  expect(html).not.toMatch(/class="step"[^>]*data-find-block/);
});

it("retains all old and new diff lines in the same searchable tree including clipped tails", () => {
  const oldText = Array.from({ length: 40 }, (_, i) => `old-line-${i}`).join(
    "\n",
  );
  const newText = Array.from({ length: 55 }, (_, i) => `new-line-${i}`).join(
    "\n",
  );
  const html = render(
    <DiffView path="/work/diff-needle" oldText={oldText} newText={newText} />,
  );
  expect(html).toContain("old-line-39");
  expect(html).toContain("new-line-54");
  expect(html.match(/old-line-39/g)).toHaveLength(1);
  expect(html.match(/new-line-54/g)).toHaveLength(1);
  expect(html).toMatch(
    /hidden=""[^>]*>[^<]*<span data-find-block="true">old-line-39/,
  );
  expect(html).toMatch(
    /hidden=""[^>]*>[^<]*<span data-find-block="true">new-line-54/,
  );
  expect(html.match(/data-find-block/g)?.length).toBeGreaterThanOrEqual(95);
});

it("offers a real expansion control for long diffs outside search", () => {
  const newText = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
  const html = render(
    <DiffView path="/work/result" oldText={null} newText={newText} />,
    false,
  );
  expect(html).not.toContain("line-49");
  expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
  expect(html).toContain("18");
});

it("registers each plan entry without including the generated status glyph or heading", () => {
  const html = render(
    <PlanBlock
      entries={[
        { content: "first-plan-needle", status: "completed", priority: "high" },
        {
          content: "second-plan-needle",
          status: "pending",
          priority: "medium",
        },
      ]}
    />,
  );
  expect(html).toContain(
    '<span data-find-block="true">first-plan-needle</span>',
  );
  expect(html).toContain(
    '<span data-find-block="true">second-plan-needle</span>',
  );
  expect(html.match(/data-find-block/g)).toHaveLength(2);
});

it("registers raw and reported extension payloads without indexing generated explanatory copy", () => {
  const html = render(
    <>
      <RawBlock update={{ unknown: "raw-needle" }} />
      <ReportedDetails details={{ extra: "extension-needle" }} />
    </>,
  );
  expect(html.match(/<pre data-find-block="true">/g)).toHaveLength(2);
  expect(html).not.toMatch(/<summary[^>]*data-find-block/);
  expect(html).not.toMatch(/<p\b[^>]*data-find-block/);
});

function stepTextBlocks(html: string) {
  return [
    ...html.matchAll(
      /<pre class="step-text" data-find-block="true">([\s\S]*?)<\/pre>/g,
    ),
  ].map((match) => match[1]);
}

it.each([undefined, "", { output: "" }])(
  "omits a zero-length raw result frame while retaining actual result content (%j)",
  (rawOutput) => {
    const source: ToolCallView = {
      ...call,
      locations: [],
      rawInput: undefined,
      rawOutput,
      content: [{ type: "text", text: "actual-result-text" }],
    };
    const original = structuredClone(source);
    const html = render(<ToolStep call={source} />);
    expect(stepTextBlocks(html)).toEqual(["actual-result-text"]);
    expect(html).toContain("步骤已结束");
    expect(source).toEqual(original);
    expect(source.rawOutput).toBe(rawOutput);
  },
);

it.each([
  ["reported-result", "reported-result"],
  [{ output: "reported-result" }, "reported-result"],
  [" \n ", " \n "],
  [{ output: " \n " }, " \n "],
  [
    { reported: "opaque-result" },
    "{\n  &quot;reported&quot;: &quot;opaque-result&quot;\n}",
  ],
  [null, "null"],
] as const)(
  "retains nonempty raw render text without trimming or replacing it (%j)",
  (rawOutput, expected) => {
    const source: ToolCallView = {
      ...call,
      locations: [],
      rawInput: undefined,
      rawOutput,
      content: [{ type: "text", text: "actual-result-text" }],
    };
    const original = structuredClone(source);
    expect(stepTextBlocks(render(<ToolStep call={source} />))).toEqual([
      "actual-result-text",
      expected,
    ]);
    expect(source).toEqual(original);
    expect(source.rawOutput).toBe(rawOutput);
  },
);

it("keeps a legitimately empty result empty and does not promote command input to output", () => {
  const source: ToolCallView = {
    ...call,
    locations: [],
    rawInput: { command: "input-only-text" },
    rawOutput: { output: "" },
    content: [],
  };
  const original = structuredClone(source);
  const html = render(<ToolStep call={source} />);
  expect(stepTextBlocks(html)).toEqual(["input-only-text"]);
  expect(html).toContain("步骤已结束");
  expect(source).toEqual(original);
});
