import type { Attachment, ThreadItem, ToolCallView } from "./session_types";
import { STRINGS } from "./strings";
import { THREAD_VIEW_STRINGS as T } from "./thread_view_strings";
import { EXPORT_STRINGS as E } from "./export_strings";

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
function source(uri: string): string {
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

function attachment(attachment: Attachment): string {
  const name = label(attachment.name) || E.attachment;
  const location = attachment.uri ? source(attachment.uri) : E.noSource;
  const type = attachment.mimeType || attachment.kind;
  return `${name} — ${location}${type ? `（${E.type}：${label(type)}）` : ""}`;
}

function toolLines(call: ToolCallView): string[] {
  const completed = call.status === "completed";
  const kinds = completed ? T.toolSummaries : T.toolKinds;
  const summary = Object.hasOwn(kinds, call.kind)
    ? kinds[call.kind as keyof typeof kinds]
    : kinds.other;
  const status = Object.hasOwn(E.status, call.status)
    ? E.status[call.status as keyof typeof E.status]
    : E.unknown;
  // Keep the existing completed one-line summary while making every status explicit.
  const first = call.locations[0];
  const out = [
    `- ${summary}${first ? ` — ${source(first.path)}` : ""}（${status}）`,
  ];
  for (const location of call.locations)
    out.push(
      `  - ${E.location}：${source(location.path)}${Number.isInteger(location.line) && location.line! >= 0 ? `（${E.line(location.line!)}）` : ""}`,
    );
  for (const content of call.content) {
    switch (content.type) {
      case "attachment":
        out.push(`  - ${E.attachment}：${attachment(content.attachment)}`);
        break;
      case "link":
        out.push(
          `  - ${E.link}：${label(content.name)} — ${source(content.uri)}`,
        );
        break;
      case "diff":
        out.push(`  - ${E.diff}：${source(content.path)}`);
        break;
      // Collapsed text/diff bodies, terminals, raw payloads and tool titles stay out.
      default:
        break;
    }
  }
  return [...out, ""];
}

/** A synchronous snapshot of the loaded readable surface. No history reads,
 * attachment fetching, disk access or transcript persistence occur here. */
export function transcriptMarkdown(
  thread: { items: ThreadItem[] },
  title: string,
  agentName: string,
): string {
  const out: string[] = [];
  for (const item of thread.items) {
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
        for (const value of attachments) out.push(`- ${attachment(value)}`);
        if (attachments.length) out.push("");
        break;
      }
      case "tool":
        out.push(...toolLines(item.call));
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
    `> ${E.scope}`,
    `> ${E.excludedScope}`,
    `> ${E.attachmentsScope}`,
    `> ${E.lineScope}`,
    `> ${E.privacyScope}`,
    "",
    ...out,
    "",
  ].join("\n");
}
