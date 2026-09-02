const fallbackTitle = "新对话";

function withoutFencedBlocks(value: string): string {
  let fenced = false;
  return value
    .split("\n")
    .filter((line) => {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    })
    .join("\n");
}

function withoutSkillBlocks(value: string): string {
  let result = value;
  while (true) {
    const start = result.toLocaleLowerCase().indexOf("<skill");
    if (start < 0) return result;
    const end = result.toLocaleLowerCase().indexOf("</skill>", start);
    result =
      end < 0
        ? result.slice(0, start)
        : result.slice(0, start) + result.slice(end + 8);
  }
}

function truncate(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length > max
    ? `${characters.slice(0, max).join("")}…`
    : value;
}

function localPathToken(value: string): boolean {
  const token = value.replace(/^[([{"'`]+/, "").replace(/[)\]}",;:.]+$/, "");
  return /^(?:file:\/\/|\/|~\/)/iu.test(token);
}

/** Produces a safe, compact fallback only from Pi-generated conversation content. */
export function cleanSessionTitle(value: string, max = 34): string {
  const clean = withoutSkillBlocks(withoutFencedBlocks(value))
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]*)\]\((?:file:\/\/|\/|~\/)[^)]+\)/giu, "$1")
    .split(/\s+/)
    .filter((token) => !localPathToken(token))
    .join(" ")
    .trim();
  if (!clean) return fallbackTitle;
  return truncate(clean, max);
}

/** Preserves a user's intentional name while keeping the UI compact and usable. */
export function cleanManualSessionTitle(value: string, max = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? truncate(clean, max) : fallbackTitle;
}
