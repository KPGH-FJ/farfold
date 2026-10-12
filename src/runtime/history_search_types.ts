/** Temporary official-history search. Never merged into the live transcript store. */
export const HISTORY_SEARCH_CODES = [
  "invalidRequest",
  "requestConflict",
  "requestCapacity",
  "busy",
  "unavailable",
  "notReviewed",
  "platformUnsupported",
  "entryUnverified",
  "environmentUnavailable",
  "selectionChanged",
  "indexChanged",
  "noNativeHistory",
  "alreadyOpen",
  "cwdUnavailable",
  "unsupported",
  "invalidOutput",
  "queryFailed",
  "outputLimit",
  "resultLimit",
  "timedOut",
  "cancelled",
  "pendingCleanup",
] as const;
export type HistorySearchCode = (typeof HISTORY_SEARCH_CODES)[number];
export const HISTORY_SEARCH_LIMITS = {
  rows: 20,
  queryBytes: 256,
  hits: 200,
  textBytes: 16384,
  ranges: 64,
  identifierBytes: 1024,
} as const;
export interface HistorySearchIdentity {
  agentId: string;
  requestId: string;
}
export interface HistorySearchRequest extends HistorySearchIdentity {
  selectionId: string;
  query: string;
}
export interface HistorySearchExpected extends HistorySearchRequest {
  rowIds: readonly string[];
}
export interface HistorySearchSelection {
  agentId: string;
  selectionId: string | null;
  validForMs: 300000;
  source: "officialAppServer" | null;
  scope: "userAndAssistantText";
  availability: "available" | "unavailable";
  code: HistorySearchCode | null;
  rows: {
    rowId: string;
    availability: "available" | "unavailable";
    code: HistorySearchCode | null;
  }[];
}
export interface HistorySearchHit {
  rowId: string;
  turnId: string;
  itemId: string;
  partIndex: number;
  role: "user" | "assistant";
  text: string;
  textTruncated: boolean;
  matches: { start: number; end: number }[];
  matchesTruncated: boolean;
}
export interface HistorySearchRow {
  rowId: string;
  state: "queued" | "reading" | "complete" | "partial" | "failed" | "skipped";
  pagesRead: number;
  textBlocksRead: number;
  matchedTextBlocks: number;
  code: HistorySearchCode | null;
}
export interface HistorySearchOperation extends HistorySearchRequest {
  rowIds: string[];
  revision: number;
  state:
    | "running"
    | "cancelling"
    | "pendingCleanup"
    | "completed"
    | "cancelled"
    | "failed";
  settled: boolean;
  code: HistorySearchCode | null;
  source: "officialAppServer";
  scope: "userAndAssistantText";
  matchMode: "unicodeLowercaseLiteral";
  exclusions: ["attachments", "toolOutput", "reasoning", "otherMessageKinds"];
  rows: HistorySearchRow[];
  hits: HistorySearchHit[];
}
export type HistorySearchReply =
  | { kind: "operation"; operation: HistorySearchOperation }
  | {
      kind: "absent";
      agentId: string;
      requestId: string;
      scope: "currentProcess";
      admissionClosed: boolean;
    };
const encoder = new TextEncoder();
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function historySearchUuid(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}
function scalarText(
  value: unknown,
  maximum: number,
  empty = false,
): value is string {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    !/[\p{Cs}]/u.test(value) &&
    encoder.encode(value).length <= maximum
  );
}
export function validHistoryQuery(value: unknown): value is string {
  return (
    scalarText(value, HISTORY_SEARCH_LIMITS.queryBytes) &&
    !!value.trim() &&
    !/[\p{Cc}]/u.test(value)
  );
}
function identifier(value: unknown): value is string {
  return (
    scalarText(value, HISTORY_SEARCH_LIMITS.identifierBytes) &&
    !/[\p{Cc}]/u.test(value)
  );
}
function invalid(): never {
  throw { code: "invalidOutput" };
}
function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(result, key))
  )
    return invalid();
  return result;
}
function code(value: unknown): value is HistorySearchCode | null {
  return (
    value === null ||
    (typeof value === "string" &&
      HISTORY_SEARCH_CODES.includes(value as HistorySearchCode))
  );
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function boolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function equalIds(
  actual: unknown,
  expected: readonly string[],
): actual is string[] {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((id, i) => identifier(id) && id === expected[i]) &&
    new Set(actual).size === actual.length
  );
}
export function historySearchError(error: unknown): HistorySearchCode {
  if (
    error &&
    typeof error === "object" &&
    Object.keys(error).length === 1 &&
    "code" in error &&
    code(error.code) &&
    error.code
  )
    return error.code;
  return "unavailable";
}
export function parseHistorySelection(
  value: unknown,
  agentId: string,
  rowIds: readonly string[],
): HistorySearchSelection {
  const v = object(value, [
    "agentId",
    "selectionId",
    "validForMs",
    "source",
    "scope",
    "availability",
    "code",
    "rows",
  ]);
  if (
    v.agentId !== agentId ||
    !identifier(v.agentId) ||
    v.validForMs !== 300000 ||
    v.scope !== "userAndAssistantText" ||
    !code(v.code) ||
    !Array.isArray(v.rows) ||
    !rowIds.length ||
    rowIds.length > 20 ||
    v.rows.length !== rowIds.length ||
    new Set(rowIds).size !== rowIds.length
  )
    return invalid();
  for (const [i, raw] of v.rows.entries()) {
    const row = object(raw, ["rowId", "availability", "code"]);
    if (
      !identifier(row.rowId) ||
      row.rowId !== rowIds[i] ||
      !code(row.code) ||
      (row.availability !== "available" && row.availability !== "unavailable")
    )
      return invalid();
    if ((row.availability === "available") !== (row.code === null))
      return invalid();
  }
  if (v.availability === "available") {
    if (
      !historySearchUuid(v.selectionId) ||
      v.source !== "officialAppServer" ||
      v.code !== null ||
      v.rows.some(
        (r) => (r as Record<string, unknown>).availability !== "available",
      )
    )
      return invalid();
  } else if (v.availability === "unavailable") {
    if (
      v.selectionId !== null ||
      v.code === null ||
      (v.source !== null && v.source !== "officialAppServer")
    )
      return invalid();
  } else return invalid();
  return value as HistorySearchSelection;
}
function surrogateBoundary(text: string, offset: number) {
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  );
}
function parseHit(value: unknown, rowIds: readonly string[]): HistorySearchHit {
  const v = object(value, [
    "rowId",
    "turnId",
    "itemId",
    "partIndex",
    "role",
    "text",
    "textTruncated",
    "matches",
    "matchesTruncated",
  ]);
  if (
    !identifier(v.rowId) ||
    !rowIds.includes(v.rowId) ||
    !identifier(v.turnId) ||
    !identifier(v.itemId) ||
    !count(v.partIndex) ||
    (v.role === "assistant" && v.partIndex !== 0) ||
    !["user", "assistant"].includes(String(v.role)) ||
    !scalarText(v.text, 16384, true) ||
    !boolean(v.textTruncated) ||
    !boolean(v.matchesTruncated) ||
    !Array.isArray(v.matches) ||
    !v.matches.length ||
    v.matches.length > 64
  )
    return invalid();
  let end = 0;
  for (const raw of v.matches) {
    const range = object(raw, ["start", "end"]);
    if (
      !count(range.start) ||
      !count(range.end) ||
      range.start < end ||
      range.end <= range.start ||
      range.end > v.text.length ||
      !surrogateBoundary(v.text, range.start) ||
      !surrogateBoundary(v.text, range.end)
    )
      return invalid();
    end = range.end;
  }
  return value as HistorySearchHit;
}
export function parseHistoryReply(
  value: unknown,
  expected: HistorySearchExpected,
): HistorySearchReply {
  if (!value || typeof value !== "object" || !("kind" in value))
    return invalid();
  if (value.kind === "absent") {
    const v = object(value, [
      "kind",
      "agentId",
      "requestId",
      "scope",
      "admissionClosed",
    ]);
    if (
      v.agentId !== expected.agentId ||
      v.requestId !== expected.requestId ||
      v.scope !== "currentProcess" ||
      !boolean(v.admissionClosed)
    )
      return invalid();
    return value as HistorySearchReply;
  }
  const envelope = object(value, ["kind", "operation"]);
  if (envelope.kind !== "operation") return invalid();
  const v = object(envelope.operation, [
    "agentId",
    "requestId",
    "selectionId",
    "rowIds",
    "query",
    "revision",
    "state",
    "settled",
    "code",
    "source",
    "scope",
    "matchMode",
    "exclusions",
    "rows",
    "hits",
  ]);
  if (
    v.agentId !== expected.agentId ||
    v.requestId !== expected.requestId ||
    v.selectionId !== expected.selectionId ||
    v.query !== expected.query ||
    !validHistoryQuery(v.query) ||
    !equalIds(v.rowIds, expected.rowIds) ||
    !v.rowIds.length ||
    v.rowIds.length > 20 ||
    !count(v.revision) ||
    !code(v.code) ||
    !boolean(v.settled) ||
    v.source !== "officialAppServer" ||
    v.scope !== "userAndAssistantText" ||
    v.matchMode !== "unicodeLowercaseLiteral" ||
    JSON.stringify(v.exclusions) !==
      JSON.stringify([
        "attachments",
        "toolOutput",
        "reasoning",
        "otherMessageKinds",
      ])
  )
    return invalid();
  if (
    ![
      "running",
      "cancelling",
      "pendingCleanup",
      "completed",
      "cancelled",
      "failed",
    ].includes(String(v.state)) ||
    v.settled !== ["completed", "cancelled", "failed"].includes(String(v.state))
  )
    return invalid();
  if ((v.state === "running" || v.state === "completed") && v.code !== null)
    return invalid();
  if (
    (v.state === "cancelling" || v.state === "cancelled") &&
    v.code !== "cancelled"
  )
    return invalid();
  if (v.state === "pendingCleanup" && v.code !== "pendingCleanup")
    return invalid();
  if (v.state === "failed" && v.code === null) return invalid();
  if (
    !Array.isArray(v.rows) ||
    v.rows.length !== expected.rowIds.length ||
    !Array.isArray(v.hits) ||
    v.hits.length > 200
  )
    return invalid();
  for (const [i, raw] of v.rows.entries()) {
    const row = object(raw, [
      "rowId",
      "state",
      "pagesRead",
      "textBlocksRead",
      "matchedTextBlocks",
      "code",
    ]);
    if (
      row.rowId !== expected.rowIds[i] ||
      ![
        "queued",
        "reading",
        "complete",
        "partial",
        "failed",
        "skipped",
      ].includes(String(row.state)) ||
      !count(row.pagesRead) ||
      row.pagesRead > 20 ||
      !count(row.textBlocksRead) ||
      !count(row.matchedTextBlocks) ||
      row.matchedTextBlocks > row.textBlocksRead ||
      !code(row.code)
    )
      return invalid();
    if (
      ["queued", "reading", "complete"].includes(String(row.state)) !==
      (row.code === null)
    )
      return invalid();
    if (v.settled && ["queued", "reading"].includes(String(row.state)))
      return invalid();
  }
  for (const hit of v.hits) parseHit(hit, expected.rowIds);
  for (const raw of v.rows) {
    const row = raw as HistorySearchRow;
    if (
      v.hits.filter((h) => (h as HistorySearchHit).rowId === row.rowId).length >
      row.matchedTextBlocks
    )
      return invalid();
  }
  const identities = v.hits.map((h) => {
    const hit = h as HistorySearchHit;
    return JSON.stringify([hit.rowId, hit.turnId, hit.itemId, hit.partIndex]);
  });
  if (new Set(identities).size !== identities.length) return invalid();
  return value as HistorySearchReply;
}
