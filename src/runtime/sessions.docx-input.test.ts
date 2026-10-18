import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), verify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
vi.mock("./document_input", () => ({ verifyDocumentInput: h.verify }));
import { threads } from "./sessions";
import { draftPersistence, draftQueues, composerDrafts } from "./drafts";
import { archiveActivity } from "./archive_activity";
import { DOCUMENT_INPUT_STRINGS as S } from "./document_input_strings";
import {
  documentBlock,
  approvedDocument,
} from "./docx_draft.test-support";
import type { PromptBlock } from "./session_types";

beforeEach(() => {
  h.invoke.mockReset();
  h.verify.mockReset().mockResolvedValue(undefined);
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
});
let serial = 0;
function scenario(reason?: string) {
  const sent: PromptBlock[][] = [];
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_prompt") {
      sent.push(structuredClone(args.content));
      return reason
        ? {
            status: reason === "unknown" ? "unknown" : "rejected",
            reason: reason === "unknown" ? undefined : reason,
          }
        : { status: "accepted" };
    }
    return command === "settings_get" ? 0 : [];
  });
  const state = threads.markOpenFailed(
    `docx-dispatch-${++serial}`,
    "chosen",
    "/owned",
    `id-${serial}`,
    "fixture",
  );
  state.openError = null;
  state.workEnabled = true;
  return { state, sent };
}

it("actual common drain sends exactly approved text on the official wire and preserves local source only in its current user projection", async () => {
  const f = scenario();
  const block = documentBlock();
  const queue = [
    { type: "text" as const, text: "question without answers" },
    block,
  ];
  expect(await threads.send(f.state.key, queue)).toEqual({
    status: "accepted",
  });
  expect(f.sent).toEqual([
    [
      { type: "text", text: "question without answers" },
      {
        type: "text",
        text: approvedDocument().text,
      },
    ],
  ]);
  expect(JSON.stringify(f.sent)).not.toContain("localDocumentText");
  const user = f.state.items.find((item) => item.kind === "user");
  expect(user).toMatchObject({
    attachments: [
      {
        text: approvedDocument().text,
        localDocumentText: approvedDocument().local,
      },
    ],
  });
  expect(block.localDocumentText).toEqual(approvedDocument().local);
  expect(f.state.queued).toEqual([]);
  expect(
    h.invoke.mock.calls.some(
      ([command]) => command === "draft_attachment_check",
    ),
  ).toBe(false);
});

it.each(["embedded_context_unsupported", "embedded_context_unknown"])(
  "definite %s preserves queued approved input, shows the common reason and does not retry or switch Agent",
  async (reason) => {
    const f = scenario(reason),
      blocks = [documentBlock()];
    expect(await threads.send(f.state.key, blocks)).toEqual({
      status: "rejected",
      reason,
    });
    expect(f.sent).toHaveLength(1);
    expect(f.state.queued).toEqual([blocks]);
    expect(draftQueues.read(f.state.key)?.blocks).toEqual([blocks]);
    expect(f.state.items.some((item) => item.kind === "user")).toBe(false);
    expect(f.state.items).toContainEqual(
      expect.objectContaining({
        kind: "notice",
        message:
          reason === "embedded_context_unsupported"
            ? S.capabilityUnsupported
            : S.capabilityUnknown,
      }),
    );
    expect(f.state.queuePaused).toBe("unavailable");
    expect(f.state.agentId).toBe("chosen");
    expect(f.state.uncertainPrompt).toBeNull();
    await Promise.resolve();
    expect(f.sent).toHaveLength(1);
  },
);

it("unknown admission remains quarantined with exact text/source and can only become a recovered draft through the existing explicit action", async () => {
  const f = scenario("unknown"),
    blocks = [documentBlock()];
  expect(await threads.send(f.state.key, blocks)).toEqual({
    status: "unknown",
    reason: undefined,
  });
  expect(f.state.uncertainPrompt).toBe(blocks);
  expect(f.state.queuePaused).toBe("uncertain");
  expect(draftQueues.read(f.state.key)).toMatchObject({
    blocks: [blocks],
    uncertainIndex: 0,
  });
  await Promise.resolve();
  expect(f.sent).toHaveLength(1);
  expect(composerDrafts.hasContent(`session:${f.state.key}`)).toBe(false);
  threads.abandonUncertainPrompt(f.state.key, blocks, true);
  expect(
    composerDrafts.read(`session:${f.state.key}`).attachments[0],
  ).toMatchObject({ documentText: approvedDocument(), recovered: true });
  expect(f.state.queued).toEqual([]);
  expect(f.state.uncertainPrompt).toBeNull();
  expect(f.state.connectionOutcomeUnknown).toBe(true);
  expect(f.state.queuePaused).toBe("uncertain");
  expect(f.sent).toHaveLength(1);
});

it("a version failure at real drain admission preserves the queue and does not dispatch or project an unsent document", async () => {
  const f = scenario(),
    blocks = [documentBlock()],
    before = structuredClone(blocks);
  h.verify.mockRejectedValue(new Error("source changed"));
  expect(await threads.send(f.state.key, blocks)).toEqual({
    status: "rejected",
    reason: "failed",
  });
  expect(f.sent).toHaveLength(0);
  expect(f.state.queued).toEqual([before]);
  expect(draftQueues.read(f.state.key)?.blocks).toEqual([before]);
  expect(f.state.items.some((item) => item.kind === "user")).toBe(false);
  expect(f.state.queuePaused).toBe("failed");
});
