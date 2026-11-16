import {
  hasPreviewContent,
  historyContinuation,
  type HistoryPreview,
} from "../runtime/history_import";
import {
  configValueLabel,
  modelConfigOption,
} from "../runtime/session_projection";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
import { LIBRARY } from "../runtime/library_strings";
import { MessageContent } from "./MessageContent";
import { ToolStep } from "./thread-items";

/** Common readonly history presentation; never attaches live action handlers. */
export function renderHistoryPreviewBody(
  preview: HistoryPreview,
  defaultCwd?: string | null,
) {
  return (
    <>
      <div className="history-continuation" role="note">
        <strong>{historyContinuation(preview).title}</strong>
        <p>{historyContinuation(preview).detail}</p>
        <dl>
          <dt>{S.currentModel}</dt>
          <dd>
            {configValueLabel(modelConfigOption(preview.state.configOptions)) ||
              S.notProvided}
          </dd>
          <dt>{S.source}</dt>
          <dd>{preview.state.service ? S.savedService : S.agentSettings}</dd>
          <dt>{S.conversationLocation}</dt>
          <dd>{preview.cwd === defaultCwd ? LIBRARY.ordinary : preview.cwd}</dd>
        </dl>
      </div>
      {!hasPreviewContent(preview) && <p>{S.noContent}</p>}
      {preview.state.items.map((item) =>
        item.kind === "user" || item.kind === "agent" ? (
          <div className={`history-message ${item.kind}`} key={item.id}>
            <small>{item.kind === "user" ? S.you : S.agentRole}</small>
            <MessageContent
              source={item}
              text={item.text}
              attachments={item.attachments}
              contentOrder={
                item.kind === "agent" ? item.contentOrder : undefined
              }
            />
          </div>
        ) : item.kind === "tool" ? (
          <div className="history-message" key={item.id}>
            <ToolStep
              call={item.call}
              activity={
                item.call.status === "completed" ||
                item.call.status === "failed"
                  ? "finished"
                  : "unknown"
              }
            />
          </div>
        ) : null,
      )}
    </>
  );
}
