/**
 * Composer pickers: slash-command filtering (agent-declared
 * `availableCommands`) and `@` file-mention matching over a project
 * file list. Pure functions — the component owns DOM/caret state.
 */

export interface CommandEntry {
  name: string;
  description?: string;
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

/** `@` anchor: index of a trailing `@` that starts a mention (start of
 *  input or right after whitespace). Returns -1 when there is none. */
export function mentionAnchor(text: string): number {
  if (!text.endsWith("@")) return -1;
  const at = text.length - 1;
  if (at === 0 || /\s/.test(text[at - 1]!)) return at;
  return -1;
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
      const base = f.split("/").pop() ?? f;
      // Basename hits rank above deep-path hits.
      const rank = matchFile(base, query) ? 0 : 1;
      return { f, rank };
    });
  scored.sort((a, b) => a.rank - b.rank || a.f.length - b.f.length);
  return scored.slice(0, limit).map((s) => s.f);
}
