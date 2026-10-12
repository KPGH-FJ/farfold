import type { Attachment, ThreadItem, ToolCallView } from "./session_types";
import { STRINGS } from "./strings";
import { THREAD_VIEW_STRINGS as T } from "./thread_view_strings";
import { EXPORT_STRINGS as E } from "./export_strings";

export interface TranscriptExportOptions {
  sourceLocations?: "reported" | "omit";
  includeLoadedToolDetails?: boolean;
  attachmentScope?: "descriptions" | "selectedArchive";
}

/** Metadata is text, never executable Markdown/HTML or another conversation row. */
function label(value: string): string {
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      // CommonMark permits backslash escaping every ASCII punctuation character.
      .replace(
        /[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g,
        "\\$&",
      )
      // Leading indentation must remain text rather than introduce a code block.
      .replace(/^ +/, (spaces) => "&#32;".repeat(spaces.length))
  );
}

/** Keep useful locations while dropping credentials and opaque/embedded payloads.
 * No file or URL is opened, and URI parameters are not copied into an export. */
function source(uri: string, options: TranscriptExportOptions): string {
  if (options.sourceLocations === "omit") return E.omittedSource;
  const value = uri.trim();
  const relativeUrl = value.startsWith("//");
  if (
    /^[a-z]:[\\/]/i.test(value) ||
    (!relativeUrl && !/^[a-z][a-z0-9+.-]*:/i.test(value))
  )
    return label(uri);
  try {
    const url = new URL(relativeUrl ? `https:${value}` : value);
    if (!["http:", "https:", "file:"].includes(url.protocol))
      return E.omittedSource;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return label(relativeUrl ? `//${url.host}${url.pathname}` : url.href);
  } catch {
    return E.omittedSource;
  }
}

function attachment(
  attachment: Attachment,
  options: TranscriptExportOptions,
): string {
  const name = label(attachment.name) || E.attachment;
  const location = attachment.uri
    ? source(attachment.uri, options)
    : E.noSource;
  const type = attachment.mimeType || attachment.kind;
  return `${name} — ${location}${type ? `（${E.type}：${label(type)}）` : ""}`;
}

/** Literal blocks preserve loaded text without interpreting it as roles, links
 * or images. A delimiter longer than every run cannot be closed by the body. */
function literalBody(value: string): string[] {
  if (value === "") return [E.emptyToolText, ""];
  let backticks = 2;
  let tildes = 2;
  for (const match of value.matchAll(/`+|~+/g)) {
    if (match[0][0] === "`") backticks = Math.max(backticks, match[0].length);
    else tildes = Math.max(tildes, match[0].length);
  }
  const fence =
    backticks <= tildes ? "`".repeat(backticks + 1) : "~".repeat(tildes + 1);
  return [
    `${fence}text\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`,
    "",
  ];
}

function toolDetails(call: ToolCallView, itemOrdinal: number): string[] {
  const out: string[] = [];
  const heading = (name: string, contentOrdinal?: number) => {
    out.push(
      `##### ${E.toolItem(itemOrdinal + 1)}${contentOrdinal === undefined ? "" : ` · ${E.toolContent(contentOrdinal + 1)}`}：${name}`,
      "",
    );
  };
  call.content.forEach((content, contentOrdinal) => {
    if (content.type === "text") {
      heading(E.toolText, contentOrdinal);
      out.push(...literalBody(content.text));
    } else if (content.type === "diff") {
      heading(E.beforeChange, contentOrdinal);
      out.push(
        ...(content.oldText === null
          ? [E.beforeUnavailable, ""]
          : literalBody(content.oldText)),
      );
      heading(E.afterChange, contentOrdinal);
      out.push(...literalBody(content.newText));
    }
  });
  if (call.terminalOutput !== undefined) {
    heading(E.terminalOutput);
    out.push(...literalBody(call.terminalOutput));
  } else if (call.content.some((content) => content.type === "terminal")) {
    heading(E.terminalOutput);
    out.push(E.terminalUnavailable, "");
  }
  return out.length && call.status !== "completed"
    ? [`> ${E.partialTool}`, "", ...out]
    : out;
}

function toolLines(
  call: ToolCallView,
  options: TranscriptExportOptions,
  itemOrdinal: number,
): string[] {
  const completed = call.status === "completed";
  const kinds = completed ? T.toolSummaries : T.toolKinds;
  const summary = Object.hasOwn(kinds, call.kind)
    ? kinds[call.kind as keyof typeof kinds]
    : kinds.other;
  const status = Object.hasOwn(E.status, call.status)
    ? E.status[call.status as keyof typeof E.status]
    : E.unknown;
  // Keep the existing completed one-line summary while making every status explicit.
  const first =
    options.sourceLocations === "omit" ? undefined : call.locations[0];
  const out = [
    `- ${summary}${first ? ` — ${source(first.path, options)}` : ""}（${status}）`,
  ];
  for (const location of options.sourceLocations === "omit"
    ? []
    : call.locations)
    out.push(
      `  - ${E.location}：${source(location.path, options)}${Number.isInteger(location.line) && location.line! >= 0 ? `（${E.line(location.line!)}）` : ""}`,
    );
  for (const content of call.content) {
    switch (content.type) {
      case "attachment":
        out.push(
          `  - ${E.attachment}：${attachment(content.attachment, options)}`,
        );
        break;
      case "link":
        out.push(
          `  - ${E.link}：${label(content.name)} — ${source(content.uri, options)}`,
        );
        break;
      case "diff":
        out.push(`  - ${E.diff}：${source(content.path, options)}`);
        break;
      // Readable bodies are appended only on explicit selection below. Raw
      // payloads, identifiers and tool titles are never exported here.
      default:
        break;
    }
  }
  return [
    ...out,
    "",
    ...(options.includeLoadedToolDetails ? toolDetails(call, itemOrdinal) : []),
  ];
}

/** A synchronous snapshot of the loaded readable surface. No history reads,
 * attachment fetching, disk access or transcript persistence occur here. */
export function transcriptMarkdown(
  thread: { items: ThreadItem[] },
  title: string,
  agentName: string,
  options: TranscriptExportOptions = {},
): string {
  // The archive disclosure and source policy are inseparable, including for
  // callers that only select the archive scope.
  if (options.attachmentScope === "selectedArchive")
    options = { ...options, sourceLocations: "omit" };
  const out: string[] = [];
  for (const [itemOrdinal, item] of thread.items.entries()) {
    switch (item.kind) {
      case "user":
      case "agent": {
        const attachments = item.attachments ?? [];
        if (!item.text.trim() && !attachments.length) break;
        out.push(
          `**${item.kind === "user" ? STRINGS.thread.you : label(agentName)}**`,
          "",
        );
        if (item.streaming) out.push(`> ${E.snapshot}`, "");
        if (item.text.trim()) out.push(item.text, "");
        for (const value of attachments)
          out.push(`- ${attachment(value, options)}`);
        if (attachments.length) out.push("");
        break;
      }
      case "tool":
        out.push(...toolLines(item.call, options, itemOrdinal));
        break;
      case "plan":
        if (!item.entries.length) break;
        out.push(`### ${STRINGS.thread.plan}`, "");
        for (const entry of item.entries)
          out.push(
            `- ${entry.status === "completed" ? "[x]" : "[ ]"} ${label(entry.content)}`,
          );
        out.push("");
        break;
      case "decision":
        out.push(`> ${label(item.label)}`, "");
        break;
      case "settled":
        if (item.status !== "done")
          out.push(`> ${STRINGS.thread[item.status]}`, "");
        break;
      default:
        break;
    }
  }
  while (out.at(-1) === "") out.pop();
  // Preserve the library's header-only empty-export guard.
  if (!out.length) return `# ${label(title)}\n`;
  return [
    `# ${label(title)}`,
    "",
    `> ${options.attachmentScope === "selectedArchive" ? E.archiveScope : E.scope}`,
    `> ${options.includeLoadedToolDetails ? E.detailsExcludedScope : E.excludedScope}`,
    ...(options.includeLoadedToolDetails ? [`> ${E.detailsScope}`] : []),
    `> ${options.attachmentScope === "selectedArchive" ? E.archiveAttachmentsScope : E.attachmentsScope}`,
    `> ${E.lineScope}`,
    `> ${options.attachmentScope === "selectedArchive" ? E.archivePrivacyScope : options.includeLoadedToolDetails ? E.detailsPrivacyScope : E.privacyScope}`,
    "",
    ...out,
    "",
  ].join("\n");
}
