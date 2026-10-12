import { expect, it, vi } from "vitest";
import { ArchiveSelection } from "./conversation_archive_selection";
import { captureConversationExport } from "./conversation_archive_snapshot";
import type { ThreadItem } from "./session_types";
const file = {
  root: "/owned",
  path: "/owned/new.txt",
  resolvedPath: "/owned/new.txt",
  name: "new.txt",
  size: 3,
  sha256: "a".repeat(64),
  version: "v1",
};
function capture() {
  return captureConversationExport(
    {
      cwd: "/owned",
      items: [
        {
          kind: "user",
          id: "u",
          text: "body",
          attachments: [{ name: "old.txt", uri: "/owned/old.txt" }],
          streaming: false,
          time: 1,
        },
      ],
    },
    "test",
    "Agent",
  );
}
it("removing a user-selected replacement restores an ordinary omitted original without a dangling replacement", async () => {
  const selection = new ArchiveSelection(
    capture(),
    vi.fn().mockResolvedValue(file),
  );
  const original = selection.getSnapshot()[0].candidate.candidateId;
  await selection.replace(original, "/owned/new.txt");
  const replacement = selection
    .getSnapshot()
    .find((r) => r.candidate.replacesCandidateId === original)!;
  await selection.select(replacement.candidate.candidateId, false);
  const input = (await selection.prepare("/owned/out.zip", () => true))!;
  expect(input.candidates).toHaveLength(1);
  expect(input.selected).toEqual([]);
  expect(input.omitted).toEqual([
    { candidateId: original, reason: "notSelected" },
  ]);
});
it("replacing the same original again leaves exactly one selected replacement and one original omission", async () => {
  const selection = new ArchiveSelection(
    capture(),
    vi.fn().mockResolvedValue(file),
  );
  const original = selection.getSnapshot()[0].candidate.candidateId;
  await selection.replace(original, "/owned/one.txt");
  await selection.replace(original, "/owned/two.txt");
  const input = (await selection.prepare("/owned/out.zip", () => true))!;
  expect(input.candidates).toHaveLength(2);
  expect(input.selected).toHaveLength(1);
  expect(input.omitted).toEqual([
    { candidateId: original, reason: "replacedByUserSelection" },
  ]);
});
it("selecting the original retires its replacement and uses fresh source verification", async () => {
  const inspect = vi.fn().mockResolvedValue(file);
  const selection = new ArchiveSelection(capture(), inspect);
  const original = selection.getSnapshot()[0].candidate.candidateId;
  await selection.replace(original, "/owned/one.txt");
  await selection.select(original, true);
  const input = (await selection.prepare("/owned/out.zip", () => true))!;
  expect(input.candidates).toHaveLength(1);
  expect(input.omitted).toEqual([]);
  expect(input.selected[0].candidateId).toBe(original);
});
it("late selected-file receipt after deselect/reselect or view retirement cannot restore the old source", async () => {
  let finish: (v: typeof file) => void = () => {};
  const inspect = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    )
    .mockResolvedValue({ ...file, version: "v2" });
  const selection = new ArchiveSelection(capture(), inspect);
  const id = selection.getSnapshot()[0].candidate.candidateId;
  const first = selection.select(id, true);
  await selection.select(id, false);
  await selection.select(id, true);
  finish(file);
  await first;
  expect(selection.getSnapshot()[0].source).toMatchObject({
    file: { version: "v2" },
  });
  selection.retire();
  expect(await selection.prepare("/owned/out.zip", () => true)).toBeNull();
});
it("body and received bytes are separate from unselected raw URI metadata; all choices begin unchecked", async () => {
  const items: ThreadItem[] = [
    {
      kind: "agent",
      id: "a",
      text: "BODY /private/keep",
      attachments: [
        {
          name: "same",
          text: " \r\n文字",
          data: "YQ==",
          uri: "https://user:URI_PRIVATE@example.test/a?token=QUERY_PRIVATE",
        },
      ],
      time: 1,
      streaming: false,
    },
  ];
  const c = captureConversationExport(
    { cwd: "/owned", items },
    "test",
    "Agent",
  );
  const inspect = vi.fn();
  const selection = new ArchiveSelection(c, inspect);
  expect(c.candidates.map((c) => c.representation)).toEqual([
    "receivedText",
    "receivedBytes",
    "referenceOnly",
  ]);
  expect(inspect).not.toHaveBeenCalled();
  await selection.select(c.candidates[0].candidateId, true);
  await selection.select(c.candidates[1].candidateId, true);
  const input = (await selection.prepare("/owned/out.zip", () => true))!;
  expect(input.markdown).toContain("BODY /private/keep");
  expect(JSON.stringify(input)).not.toMatch(/URI_PRIVATE|QUERY_PRIVATE/);
  expect(input.selected).toHaveLength(2);
  expect(input.omitted[0].reason).toBe("remoteNotFetched");
  expect(inspect).not.toHaveBeenCalled();
});

it("registration releases selection payload and does not change the immutable conversation capture", async () => {
  const c = capture();
  const selection = new ArchiveSelection(c, vi.fn().mockResolvedValue(file));
  await selection.select(c.candidates[0].candidateId, true);
  const input = (await selection.prepare("/owned/out.zip", () => true))!;
  selection.releasePayload();
  selection.activate();
  expect(selection.getSnapshot()).toEqual([]);
  expect(await selection.prepare("/owned/other.zip", () => true)).toBeNull();
  expect(input.selected).toHaveLength(1);
  expect(c.candidates).toHaveLength(1);
});
