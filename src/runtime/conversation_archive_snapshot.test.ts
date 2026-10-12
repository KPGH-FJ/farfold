import { expect, it } from "vitest";
import { captureConversationExport } from "./conversation_archive_snapshot";
import type { ThreadItem, ToolCallView } from "./session_types";
const user: ThreadItem = {
  kind: "user",
  id: "u",
  text: "ordinary body",
  attachments: [],
  streaming: false,
  time: 1,
};
const tool = (changes: Partial<ToolCallView>): ThreadItem => ({
  kind: "tool",
  id: "t",
  call: {
    toolCallId: "t",
    title: "private",
    kind: "execute",
    status: "completed",
    locations: [],
    content: [],
    startedAt: 1,
    ...changes,
  },
});
it("an oversized optional loaded detail cannot disable original ordinary Markdown", () => {
  const c = captureConversationExport(
    {
      cwd: "/owned",
      items: [user, tool({ terminalOutput: "x".repeat(1024 * 1024 + 1) })],
    },
    "test",
    "Agent",
  );
  expect(c.markdown).toContain("ordinary body");
  expect(c.markdown).not.toContain("x".repeat(100));
  expect(c.unavailable.markdown).toBe(false);
  expect(c.unavailable.details).toBe(true);
});
it("an archive candidate budget cannot disable the unchanged Markdown export", () => {
  const item = {
    ...user,
    attachments: Array.from({ length: 4097 }, () => ({
      name: "a",
      text: "received",
    })),
  } as ThreadItem;
  const c = captureConversationExport(
    { cwd: "/owned", items: [item] },
    "test",
    "Agent",
  );
  expect(c.unavailable.markdown).toBe(false);
  expect(c.unavailable.archive).toBe(true);
  expect(c.candidates.length).toBeLessThanOrEqual(4096);
});
it("captures readable details and portable variants once without raw or generated source paths", () => {
  const item = tool({
    locations: [{ path: "/PRIVATE_AUTOMATIC_PATH" }],
    content: [
      {
        type: "diff",
        path: "/PRIVATE_AUTOMATIC_PATH",
        oldText: null,
        newText: "BODY /intentional/path",
      },
      { type: "text", text: "safe ```\nbody" },
      { type: "raw", value: { secret: "RAW_CANARY" } },
    ],
    terminalOutput: "one\n",
  });
  const c = captureConversationExport(
    { cwd: "/owned", items: [user, item] },
    "test",
    "Agent",
  );
  expect(c.archiveMarkdown).not.toContain("PRIVATE_AUTOMATIC_PATH");
  expect(c.detailedArchiveMarkdown).toContain("BODY /intentional/path");
  expect(c.detailedArchiveMarkdown).not.toContain("RAW_CANARY");
  if (item.kind === "tool") item.call.terminalOutput = "NEW_LATE";
  expect(c.detailedArchiveMarkdown).not.toContain("NEW_LATE");
  expect(c.toolDetailCount).toBe(3);
});

import memberCases from "./fixtures/archive-member-cases.json";
import {
  archiveMember,
  releasedExportSnapshot,
} from "./conversation_archive_snapshot";
it.each(memberCases)(
  "uses only a bounded filename suffix hint: $displayName ($inlineText)",
  (c) =>
    expect(archiveMember(c.index, c.inlineText, c.displayName)).toBe(c.member),
);
it("releases only export-owned payload while retaining its safe snapshot identity", () => {
  const c = captureConversationExport(
    {
      cwd: "/owned",
      items: [
        {
          kind: "user",
          id: "u",
          text: "PRIVATE_BODY",
          attachments: [{ name: "a", text: "PRIVATE_ATTACHMENT" }],
          streaming: false,
          time: 1,
        },
      ],
    },
    "t",
    "a",
  );
  const empty = releasedExportSnapshot(c);
  expect(empty.snapshotId).toBe(c.snapshotId);
  expect(JSON.stringify(empty)).not.toMatch(/PRIVATE_BODY|PRIVATE_ATTACHMENT/);
  expect(c.markdown).toContain("PRIVATE_BODY");
});
