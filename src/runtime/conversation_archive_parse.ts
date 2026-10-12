import type {
  ArchiveCode,
  ArchiveIdentity,
  ArchiveReply,
  ArchiveStatus,
  ArchiveRequestKey,
} from "./conversation_archive_types";
const codes: readonly string[] = [
  "invalidRequest",
  "invalidData",
  "tooLarge",
  "changed",
  "unreadable",
  "alreadyExists",
  "invalidDestination",
  "destinationChanged",
  "writeFailed",
  "cleanupUnknown",
  "busy",
  "unavailable",
  "requestConflict",
  "requestRetired",
  "requestCapacity",
];
export function archiveCode(v: unknown): ArchiveCode {
  const code = v && typeof v === "object" && "code" in v ? v.code : null;
  return typeof code === "string" && codes.includes(code)
    ? (code as ArchiveCode)
    : "unavailable";
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw { code: "invalidData" };
  return v as Record<string, unknown>;
}
function exact(v: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw { code: "invalidData" };
}
function need(test: boolean): asserts test {
  if (!test) throw { code: "invalidData" };
}
const uint = (v: unknown) =>
  Number.isSafeInteger(v) &&
  typeof v === "number" &&
  v >= 0 &&
  !Object.is(v, -0);
const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function parseArchiveReply(
  value: unknown,
  expected: ArchiveIdentity | ArchiveRequestKey,
): ArchiveReply {
  const v = record(value);
  need(
    v.kind === "conversationArchive" &&
      v.operationId === expected.operationId &&
      v.inputSha256 === expected.inputSha256,
  );
  if (v.state === "absent") {
    exact(v, [
      "kind",
      "operationId",
      "inputSha256",
      "state",
      "settled",
      "admissionClosed",
      "result",
      "scope",
    ]);
    need(
      v.settled === true &&
        typeof v.admissionClosed === "boolean" &&
        v.result === "unknown" &&
        v.scope === "currentProcess",
    );
    return value as ArchiveReply;
  }
  exact(v, [
    "kind",
    "operationId",
    "inputSha256",
    "snapshotId",
    "selectionId",
    "destination",
    "includedCount",
    "omittedCount",
    "totalInputBytes",
    "processedInputBytes",
    "itemsCompleted",
    "state",
    "settled",
    "publication",
    "receipt",
    "code",
    "failedCandidateId",
  ]);
  need("snapshotId" in expected);
  for (const key of [
    "snapshotId",
    "selectionId",
    "destination",
    "includedCount",
    "omittedCount",
    "totalInputBytes",
  ] as const)
    need(v[key] === expected[key]);
  need(
    uint(v.processedInputBytes) &&
      (v.processedInputBytes as number) <= expected.totalInputBytes &&
      uint(v.itemsCompleted) &&
      (v.itemsCompleted as number) <= expected.includedCount,
  );
  need(v.failedCandidateId === null || typeof v.failedCandidateId === "string");
  const active = ["ready", "writing", "cancelling", "publishing"].includes(
    String(v.state),
  );
  const terminal = ["completed", "cancelled", "failed", "unknown"].includes(
    String(v.state),
  );
  need((active && v.settled === false) || (terminal && v.settled === true));
  if (v.state === "completed") {
    need(
      v.publication === "published" &&
        v.code === null &&
        v.failedCandidateId === null &&
        v.processedInputBytes === expected.totalInputBytes &&
        v.itemsCompleted === expected.includedCount,
    );
    const r = record(v.receipt);
    exact(r, [
      "kind",
      "destination",
      "zipSize",
      "zipSha256",
      "manifestSha256",
      "includedCount",
      "omittedCount",
      "scope",
    ]);
    need(
      r.kind === "conversationArchive" &&
        r.destination === expected.destination &&
        uint(r.zipSize) &&
        (r.zipSize as number) > 0 &&
        (r.zipSize as number) <= 1024 ** 3 + 4 * 1024 ** 2 &&
        sha(r.zipSha256) &&
        sha(r.manifestSha256) &&
        r.includedCount === expected.includedCount &&
        r.omittedCount === expected.omittedCount &&
        r.scope === "selectedLoadedSnapshot",
    );
  } else {
    need(v.receipt === null);
    need(
      v.publication ===
        (["publishing", "unknown"].includes(String(v.state))
          ? "unknown"
          : "notPublished"),
    );
    if (v.state === "failed" || v.state === "unknown")
      need(typeof v.code === "string" && codes.includes(v.code));
    else need(v.code === null && v.failedCandidateId === null);
    if (v.state === "ready")
      need(v.itemsCompleted === 0 && v.processedInputBytes === 0);
  }
  return value as ArchiveStatus;
}
