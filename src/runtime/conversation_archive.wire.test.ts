import { expect, it } from "vitest";
import wire from "../../docs/evidence/2026-10-09-capability-hardening/attachment-archive/backend/canonical-wire.json";
import {
  archiveCanonical,
  archiveInput,
  binarySize,
} from "./conversation_archive_input";
import { parseArchiveReply } from "./conversation_archive_parse";
import type {
  ArchiveIdentity,
  ArchivePrepareInput,
} from "./conversation_archive_types";
it.each(wire.map((value, index) => ({ value, index })))(
  "matches actual Rust canonical bytes, SHA and ready receipt $index",
  async ({ value }) => {
    const input = value.input as ArchivePrepareInput;
    expect(archiveCanonical(input)).toBe(value.canonical);
    expect((await archiveInput(input)).inputSha256).toBe(value.sha256);
    expect(
      parseArchiveReply(value.ready, value.ready as ArchiveIdentity),
    ).toEqual(value.ready);
  },
);
it.each(["a===", "YR==", "AAA", "AA==\n"])(
  "rejects noncanonical binary %j",
  (v) => expect(() => binarySize(v)).toThrow(),
);
it("rejects malformed digest scalars without normalizing original bytes", () => {
  const input = structuredClone(wire[0].input) as ArchivePrepareInput;
  expect(() => archiveCanonical({ ...input, markdown: "\ud800" })).toThrow();
  input.candidates[0].origin.itemOrdinal = -0;
  expect(() => archiveCanonical(input)).toThrow();
});
it("strict receipt cannot infer completed from zero bytes or claim absent is cancellation", () => {
  const r = wire[1].ready;
  const identity = r as ArchiveIdentity;
  for (const bad of [
    { ...r, state: "completed", settled: true, publication: "published" },
    { ...r, itemsCompleted: 1 },
    { ...r, kind: "fileCopy" },
    { ...r, inputSha256: "f".repeat(64) },
    { ...r, extra: true },
  ])
    expect(() => parseArchiveReply(bad, identity)).toThrow();
  expect(() =>
    parseArchiveReply(
      {
        kind: "conversationArchive",
        operationId: r.operationId,
        inputSha256: r.inputSha256,
        state: "absent",
        settled: true,
        admissionClosed: true,
        result: "cancelled",
        scope: "currentProcess",
      },
      identity,
    ),
  ).toThrow();
});
