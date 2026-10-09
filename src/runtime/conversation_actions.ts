import type { Credential, ServiceSelection } from "./credentials";
import type { ThreadState } from "./sessions";
import { STRINGS } from "./strings";
import { THREAD_VIEW_STRINGS as T } from "./thread_view_strings";

/**
 * W3-9 对话管理：导出与“相同设置再开一段”的纯数据助手。
 * 只读取对话索引里已保存的选择与已加载的消息投影，不产生新的写入。
 */

export type StoredServiceRecord =
  | { kind: "existing" }
  | {
      kind: "configured";
      identity?: { id?: string; model?: string; fingerprint?: string };
    };

/** Missing historical source data must not silently become today's defaults. */
export function historicalSelectionNeedsReview(
  value: unknown,
  credentials?: readonly Credential[],
): boolean {
  if (!value || typeof value !== "object") return true;
  const record = value as {
    _farfoldConfig?: unknown;
    choices?: unknown;
    _farfoldService?: StoredServiceRecord;
  };
  if (record._farfoldConfig !== 2 || !Array.isArray(record.choices))
    return true;
  const source = record._farfoldService;
  if (source?.kind === "existing") return false;
  const incomplete =
    source?.kind !== "configured" ||
    !source.identity?.id ||
    !source.identity?.model ||
    !source.identity?.fingerprint;
  return (
    incomplete ||
    (credentials !== undefined &&
      !storedConversationSelection(value, credentials).service?.revision)
  );
}

/** Only the user's still-current non-secret service choice may prepare a new conversation. */
export function serviceSelectionIsCurrent(
  selection: ServiceSelection & { revision: string },
  credentials: readonly Credential[],
): boolean {
  return (
    !!selection.revision &&
    credentials.some(
      (item) =>
        item.id === selection.id &&
        item.revision === selection.revision &&
        item.complete &&
        !item.deleting &&
        item.models.includes(selection.model),
    )
  );
}

/** Read `configOptions` recorded on an index row into the draft-selection
 *  shape (`initialSelection`/`PreparedSelection`) used by the new-conversation
 *  flow. Unknown or older record shapes degrade to empty config rather than
 *  inventing values. */
export function storedConversationSelection(
  configOptions: unknown,
  credentials: readonly Credential[],
): {
  service: (ServiceSelection & { revision: string }) | null;
  config: Record<string, unknown>;
} {
  const config: Record<string, unknown> = {};
  let service: (ServiceSelection & { revision: string }) | null = null;
  if (!configOptions || typeof configOptions !== "object")
    return { service, config };
  const record = configOptions as {
    _farfoldConfig?: unknown;
    choices?: unknown;
    _farfoldService?: StoredServiceRecord;
  };
  if (record._farfoldConfig === 2 && Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (
        choice &&
        typeof choice === "object" &&
        typeof (choice as { id?: unknown }).id === "string" &&
        typeof (choice as { value?: unknown }).value === "string"
      )
        config[(choice as { id: string }).id] = (
          choice as { value: string }
        ).value;
    }
  }
  const source = record._farfoldService;
  if (
    source?.kind === "configured" &&
    typeof source.identity?.id === "string" &&
    typeof source.identity.model === "string"
  ) {
    // A revision also changes on key rotation and model-list edits. Reuse the
    // backend's address/format identity to distinguish those from a different
    // source; only an unchanged source with the saved model can adopt today's
    // revision. Otherwise keep the old choice visible for explicit reselection.
    const current = credentials.find((item) => item.id === source.identity!.id);
    const sameSource =
      typeof source.identity.fingerprint === "string" &&
      !!source.identity.fingerprint &&
      current?.fingerprint === source.identity.fingerprint &&
      current.complete &&
      !current.deleting &&
      current.models.includes(source.identity.model);
    service = {
      id: source.identity.id,
      model: source.identity.model,
      revision: sameSource ? current.revision : "",
    };
  }
  return { service, config };
}

const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Default file name for a Markdown export; keeps the title readable. */
export function exportFileName(title: string): string {
  const base = title.replace(UNSAFE_FILENAME, " ").replace(/\s+/g, " ").trim();
  return `${base.slice(0, 60) || STRINGS.sessions.untitled}.md`;
}

function toolSummary(kind: string): string {
  return Object.hasOwn(T.toolSummaries, kind)
    ? T.toolSummaries[kind as keyof typeof T.toolSummaries]
    : T.toolSummaries.other;
}

/** The readable conversation surface as Markdown — user/agent text, tool
 *  one-line summaries and round results; collapsed technical detail and raw
 *  updates stay out, matching `readableTranscript`'s layer. */
export function transcriptMarkdown(
  thread: Pick<ThreadState, "items">,
  title: string,
  agentName: string,
): string {
  const out: string[] = [`# ${title}`, ""];
  for (const item of thread.items) {
    switch (item.kind) {
      case "user":
        out.push(`**${STRINGS.thread.you}**`, "");
        if (item.text.trim()) out.push(item.text.trim(), "");
        for (const attachment of item.attachments)
          out.push(
            `- ${attachment.name}${attachment.uri ? ` — ${attachment.uri}` : ""}`,
          );
        if (item.attachments.length) out.push("");
        break;
      case "agent":
        if (!item.text.trim()) break;
        out.push(`**${agentName}**`, "", item.text.trim(), "");
        break;
      case "tool":
        out.push(
          `- ${toolSummary(item.call.kind)}${item.call.locations[0] ? ` — ${item.call.locations[0].path}` : ""}`,
        );
        break;
      case "plan":
        out.push(`### ${STRINGS.thread.plan}`, "");
        for (const entry of item.entries)
          out.push(
            `- ${entry.status === "completed" ? "[x]" : "[ ]"} ${entry.content}`,
          );
        out.push("");
        break;
      case "decision":
        out.push(`> ${item.label}`, "");
        break;
      case "settled":
        if (item.status !== "done")
          out.push(`> ${STRINGS.thread[item.status]}`, "");
        break;
      default:
        break;
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}
