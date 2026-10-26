import {
  closeHistoryPreview,
  readHistoryPreview,
  type HistoryPreview,
} from "./history_import";
import {
  historySearchError,
  validHistoryQuery,
  type HistoryReadCleanupReceipt,
  type HistoryReadHit,
  type HistoryReadInput,
  type HistoryReadOperation,
  type HistoryReadRow,
  type HistoryReadTarget,
  type HistorySearchCode,
} from "./history_search_types";
import { createLoadedSearchParser } from "./loaded_search_worker";
import { checkedMessageContentOrder } from "./message_content_order";
import { searchSnippetContext } from "./search_snippet";
import { textImageParts } from "./text_image_links";

/** Consumer budgets, not a bound on the Agent's replay or process memory. */
export const HISTORY_READ_LIMITS = {
  rows: 20,
  fieldCharacters: 1_048_576,
  characters: 16_777_216,
  fields: 16_384,
  blocks: 32_768,
  hits: 200,
  ranges: 64,
} as const;

function excerpt(
  rowId: string,
  blockIndex: number,
  fieldIndex: number,
  role: HistoryReadHit["role"],
  field: string,
  regex: RegExp,
): HistoryReadHit | null {
  regex.lastIndex = 0;
  let match = regex.exec(field);
  if (!match) return null;
  const context = searchSnippetContext(
    field,
    match.index,
    match.index + match[0].length,
  );
  const from = match.index - context.before.length;
  const text = context.before + match[0] + context.after;
  const to = from + text.length;
  const matches: { start: number; end: number }[] = [];
  let matchesTruncated = false;
  do {
    const end = match.index + match[0].length;
    if (end > to || matches.length === HISTORY_READ_LIMITS.ranges) {
      matchesTruncated = true;
      break;
    }
    matches.push({ start: match.index - from, end: end - from });
  } while ((match = regex.exec(field)));
  return {
    rowId,
    role,
    text,
    textTruncated: from !== 0 || to !== field.length,
    matches,
    matchesTruncated,
    locator: { kind: "returnedText", blockIndex, fieldIndex },
  };
}

/** One existing search flight consumes exact read owners serially. No bodies persist. */
export async function readSelectedHistory(
  input: HistoryReadInput,
): Promise<HistoryReadOperation> {
  const rows: HistoryReadRow[] = input.targets.map((target) => ({
    rowId: target.rowId,
    coverage: "unread",
    textBlocksRead: 0,
    matchedTextBlocks: 0,
    skippedFields: 0,
    sourceStatus: "notRead",
    code: target.unavailable,
  }));
  let hits: HistoryReadHit[] = [];
  let interested = true;
  const current = () => {
    if (!interested) return false;
    try {
      interested = !input.signal.aborted && input.current();
    } catch {
      interested = false;
    }
    return interested;
  };
  let state: HistoryReadOperation["state"] = "reading";
  let code: HistorySearchCode | null = null;
  let pendingCleanup: HistoryReadOperation["pendingCleanup"] = null;
  let unconfirmedWithoutReceipt = false;
  const snapshot = (): HistoryReadOperation => ({
    agentId: input.agentId,
    requestId: input.requestId,
    source: "officialSessionLoad",
    query: input.query,
    rowIds: input.targets.map((target) => target.rowId),
    scope: "userAndAssistantText",
    coverageScope: "acknowledgedLoadPrefix",
    textScope: "returnedVisibleFields",
    matchMode: "ecmascriptUnicodeLiteral",
    exclusions: ["attachments", "toolOutput", "reasoning", "otherMessageKinds"],
    state,
    settled: state === "finished",
    code,
    rows: rows.map((row) => ({ ...row })),
    hits: current() ? [...hits] : [],
    pendingCleanup,
  });
  const publish = () => {
    try {
      input.onProgress(snapshot());
    } catch {
      // An unavailable view cannot revoke our obligation to close its owner.
      interested = false;
    }
  };
  if (
    !validHistoryQuery(input.query) ||
    !input.targets.length ||
    input.targets.length > HISTORY_READ_LIMITS.rows ||
    new Set(input.targets.map((target) => target.rowId)).size !==
      input.targets.length ||
    input.targets.some(
      (target) => target.agentId !== input.agentId || !target.rowId,
    )
  ) {
    state = "finished";
    code = "invalidRequest";
    return snapshot();
  }
  // Escaped literal RegExp indices refer to the original UTF-16 field. In
  // particular, no lowercase copy's offsets are applied to the source string.
  const regex = new RegExp(
    input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const parser = createLoadedSearchParser(input.signal);
  let characters = 0;
  let fields = 0;
  const checkpoint = async () => {
    if (!current()) throw new DOMException("Read retired", "AbortError");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!current()) throw new DOMException("Read retired", "AbortError");
  };
  async function matchPreview(
    target: HistoryReadTarget,
    row: HistoryReadRow,
    preview: HistoryPreview,
  ): Promise<HistoryReadHit[]> {
    const found: HistoryReadHit[] = [];
    let limited = false;
    const consume = async (
      visible: string[],
      blockIndex: number,
      base: number,
      role: HistoryReadHit["role"],
    ) => {
      for (const [offset, field] of visible.entries()) {
        if (
          fields >= HISTORY_READ_LIMITS.fields ||
          hits.length + found.length >= HISTORY_READ_LIMITS.hits
        ) {
          row.skippedFields += visible.length - offset;
          row.coverage = "limited";
          row.code = "resultLimit";
          return false;
        }
        if (fields % 32 === 0) await checkpoint();
        fields++;
        if (!field) continue;
        row.textBlocksRead++;
        const hit = excerpt(
          target.rowId,
          blockIndex,
          base + offset,
          role,
          field,
          regex,
        );
        if (hit) {
          row.matchedTextBlocks++;
          found.push(hit);
          limited ||= hit.matchesTruncated;
        }
      }
      return true;
    };
    for (const [blockIndex, item] of preview.state.items.entries()) {
      if (blockIndex >= HISTORY_READ_LIMITS.blocks) {
        row.skippedFields++;
        row.coverage = "limited";
        row.code = "outputLimit";
        return found;
      }
      if (blockIndex % 32 === 0) await checkpoint();
      if (item.kind !== "user" && item.kind !== "agent") continue;
      await checkpoint();
      if (
        item.text.length > HISTORY_READ_LIMITS.fieldCharacters ||
        characters + item.text.length > HISTORY_READ_LIMITS.characters
      ) {
        // One omitted body input; its unparsed derived fields are unknown.
        row.skippedFields++;
        limited = true;
        continue;
      }
      characters += item.text.length;
      if (item.kind === "user") {
        const visible = textImageParts(item.text).flatMap((part) =>
          part.kind === "text" ? [part.text] : [],
        );
        if (!(await consume(visible, blockIndex, 0, "user"))) return found;
      } else {
        const order = checkedMessageContentOrder(
          item.text.length,
          item.attachments?.length ?? 0,
          item.contentOrder,
        );
        const runs =
          order === null
            ? [item.text]
            : order.flatMap((part) =>
                part.kind === "text"
                  ? [item.text.slice(part.start, part.end)]
                  : [],
              );
        let base = 0;
        for (const run of runs) {
          await checkpoint();
          const visible = await parser.parse(run);
          if (!(await consume(visible, blockIndex, base, "assistant")))
            return found;
          base += visible.length;
        }
      }
    }
    row.coverage = limited
      ? "limited"
      : row.textBlocksRead
        ? "completeReturnedPrefix"
        : "completeEmpty";
    row.code = limited ? "outputLimit" : null;
    return found;
  }
  try {
    for (const [index, target] of input.targets.entries()) {
      if (!current()) {
        code = "cancelled";
        break;
      }
      const row = rows[index];
      if (target.unavailable || !target.nativeSessionId) {
        row.code = target.unavailable ?? "noNativeHistory";
        row.coverage = row.code === "unsupported" ? "unsupported" : "unread";
        publish();
        continue;
      }
      if (
        fields >= HISTORY_READ_LIMITS.fields ||
        hits.length >= HISTORY_READ_LIMITS.hits ||
        characters >= HISTORY_READ_LIMITS.characters
      ) {
        row.code = "resultLimit";
        code = "resultLimit";
        continue;
      }
      row.coverage = "reading";
      state = "reading";
      publish();
      if (!current()) {
        row.coverage = "sourceChanged";
        row.code = "sourceChanged";
        code = "cancelled";
        break;
      }
      let receipt: HistoryReadCleanupReceipt | null = null;
      let rowHits: HistoryReadHit[] = [];
      let stop = false;
      try {
        let preview: HistoryPreview | undefined = await readHistoryPreview(
          input.agentId,
          { cwd: target.cwd, nativeSessionId: target.nativeSessionId },
          { inquiryCurrent: current, inquirySignal: input.signal },
        );
        receipt = {
          agentId: preview.agentId,
          cwd: preview.cwd,
          nativeSessionId: preview.nativeSessionId,
          previewToken: preview.previewToken,
        };
        try {
          if (!current()) {
            row.coverage = "sourceChanged";
            row.code = "sourceChanged";
            stop = true;
          } else if (
            preview.purpose !== "searchReadOnly" ||
            !preview.replayComplete ||
            preview.state.openError ||
            preview.state.historyUnavailable ||
            preview.agentId !== input.agentId ||
            preview.nativeSessionId !== target.nativeSessionId
          ) {
            row.coverage = "incomplete";
            row.code = "coverageUnconfirmed";
          } else {
            row.sourceStatus = preview.state.service
              ? "configuredConnectionReported"
              : "sourceUnconfirmed";
            rowHits = await matchPreview(target, row, preview);
          }
        } finally {
          // Pending close retains only exact cleanup fields and bounded hits,
          // never this private state, media, or the complete replay body.
          preview = undefined;
        }
      } catch (error) {
        rowHits = [];
        row.coverage = current() ? "incomplete" : "sourceChanged";
        row.code = current() ? historySearchError(error) : "sourceChanged";
        // An unknown failed invoke is not proof of native settlement. Keep
        // later targets unread rather than dispatching another load blindly.
        stop = true;
        code = row.code;
        unconfirmedWithoutReceipt = receipt === null;
      } finally {
        if (receipt) {
          state = "settling";
          publish();
          try {
            await closeHistoryPreview(receipt);
          } catch {
            pendingCleanup = { rowId: target.rowId, receipt };
            state = "pendingCleanup";
            code = "pendingCleanup";
            row.code = "pendingCleanup";
          }
        }
      }
      if (!current()) {
        hits = [];
        code = pendingCleanup
          ? "pendingCleanup"
          : unconfirmedWithoutReceipt
            ? "unavailable"
            : "cancelled";
        stop = true;
      } else hits.push(...rowHits);
      publish();
      if (pendingCleanup || stop) break;
    }
    if (!pendingCleanup)
      state = unconfirmedWithoutReceipt ? "unconfirmed" : "finished";
    if (!current()) hits = [];
    publish();
    return snapshot();
  } finally {
    parser.dispose();
  }
}
