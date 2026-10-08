import { fileBasename } from "./file_paths";
/**
 * Composer pickers: slash-command filtering (agent-declared
 * `availableCommands`) and `@` file-mention matching over a project
 * file list. Pure functions — the component owns DOM/caret state.
 */

export interface CommandEntry {
  name: string;
  description?: string;
  input?: { hint: string };
}

/** Official free-text hint only; never insert it into the user's draft. */
export function commandInputHint(
  commands: readonly CommandEntry[],
  text: string,
): string | undefined {
  const command = /^\/(\S+)\s*$/.exec(text)?.[1];
  return commands.find((entry) => entry.name === command)?.input?.hint;
}

/** Slash query: the whole input must be a single `/token` (command is
 *  always the first token). Returns the prefix after `/`, or null. */
export function slashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? (match[1] ?? "") : null;
}

/** Commands whose name starts with the query (case-insensitive). */
export function filterCommands(
  commands: CommandEntry[],
  query: string,
): CommandEntry[] {
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * W3-7：Agent 命令与本地快捷指令共用同一入口。统一列表按组排序——
 * Agent 命令在前、快捷指令在后；斜杠输入按同一个 query 过滤两组。
 */
export interface ComposerAction {
  kind: "command" | "template";
  /** Row label: `/name` for Agent commands, the short label for templates. */
  label: string;
  /** Secondary line: command description or template preview. */
  detail?: string;
  /** Insert payload: the command name for commands, the body for templates. */
  insert: string;
}

export function filterComposerActions(
  commands: readonly CommandEntry[],
  templates: readonly { label: string; text: string }[],
  query: string,
): ComposerAction[] {
  const q = query.trim().toLowerCase();
  const matchedCommands = filterCommands([...commands], q).map((c) => ({
    kind: "command" as const,
    label: `/${c.name}`,
    detail: c.description,
    insert: c.name,
  }));
  const matchedTemplates = templates
    .filter(
      (t) =>
        !q ||
        t.label.toLowerCase().includes(q) ||
        t.text.toLowerCase().includes(q),
    )
    .map((t) => ({
      kind: "template" as const,
      label: t.label,
      detail: t.text,
      insert: t.text,
    }));
  return [...matchedCommands, ...matchedTemplates];
}

/** Trailing mention token, including a pasted filename; never an email. */
export function mentionAnchor(text: string): number {
  const match = /(?:^|\s)@[^\s@]*$/.exec(text);
  return match ? text.lastIndexOf("@") : -1;
}

/** The live mention query once a picker is open: text after the anchor,
 *  up to the first whitespace (which also means "picker should close"). */
export function mentionQuery(text: string, anchor: number): string | null {
  if (anchor < 0 || anchor >= text.length || text[anchor] !== "@") return null;
  const q = text.slice(anchor + 1);
  return /\s/.test(q) ? null : q;
}

/** Fuzzy-ish file match: every query character must appear in order
 *  (case-insensitive). Keeps ranking trivially predictable — shorter
 *  paths and earlier matches first. */
export function matchFile(path: string, query: string): boolean {
  if (!query) return true;
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of p) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return true;
  }
  return false;
}

export function filterFiles(
  files: string[],
  query: string,
  limit = 50,
): string[] {
  const scored = files
    .filter((f) => matchFile(f, query))
    .map((f) => {
      const base = fileBasename(f);
      // Basename hits rank above deep-path hits.
      const rank = matchFile(base, query) ? 0 : 1;
      return { f, rank };
    });
  scored.sort((a, b) => a.rank - b.rank || a.f.length - b.f.length);
  return scored.slice(0, limit).map((s) => s.f);
}
