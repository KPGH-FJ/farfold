import { COMPACTION as C } from "../runtime/compaction_strings";
import type { CompactionView } from "../runtime/compaction";
import { normalizeMessageAttachment } from "../runtime/message_attachments";
import { MessageContent, type OpenMessageFile } from "./MessageContent";
import { RawBlock } from "./thread-items";
import "../compaction.css";

function summaryParts(values: readonly unknown[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const value of values) {
    const block = value as Record<string, unknown>;
    const previous = parts.at(-1);
    if (block.type === "text" && previous?.type === "text") {
      previous.text = String(previous.text) + String(block.text);
    } else parts.push({ ...block });
  }
  return parts;
}

export function CompactionCard({
  item,
  onOpenFile,
}: {
  item: CompactionView;
  onOpenFile?: OpenMessageFile;
}) {
  const label =
    item.observation === "unknown"
      ? C.unknown
      : item.status === "in_progress"
        ? C.inProgress
        : item.status === "completed"
          ? C.completed
          : item.status === "failed"
            ? C.failed
            : item.status === "cancelled"
              ? C.cancelled
              : C.opaque;
  return (
    <section
      className="compaction-card"
      aria-label={label}
      onKeyDown={(event) => {
        if (["Enter", " ", "Backspace"].includes(event.key))
          event.stopPropagation();
      }}
    >
      <p className="compaction-status" role="status">
        {label}
      </p>
      {item.error !== undefined && (
        <p className="compaction-error">{item.error}</p>
      )}
      {item.summary.length > 0 ? (
        <details className="compaction-summary">
          <summary>
            {item.status === "completed" && !item.observation
              ? C.summary
              : C.partialSummary}
          </summary>
          {summaryParts(item.summary).map((value, index) => {
            const block = value as Record<string, unknown>;
            const attachment = normalizeMessageAttachment(block);
            return typeof block.text === "string" && block.type === "text" ? (
              <MessageContent
                key={index}
                source={block}
                text={block.text}
                onOpenFile={onOpenFile}
              />
            ) : attachment ? (
              <MessageContent
                key={index}
                source={block}
                text=""
                attachments={[attachment]}
                onOpenFile={onOpenFile}
              />
            ) : (
              <RawBlock key={index} update={block} />
            );
          })}
        </details>
      ) : item.status === "completed" ? (
        <p className="compaction-note">{C.noSummary}</p>
      ) : null}
      <RawBlock
        label={C.details}
        update={{
          ...item.details,
          ...(item.summaryDetails.length
            ? { summaryChunks: item.summaryDetails }
            : {}),
        }}
      />
    </section>
  );
}
