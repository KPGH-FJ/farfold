/** Keep bounded context from the original text without cutting a UTF-16 pair.
 * Match offsets and the matched text stay owned by the caller. This does not
 * normalize source text or promise whole grapheme clusters at the edges. */
export function searchSnippetContext(text: string, start: number, end: number) {
  const cutsPair = (offset: number) =>
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff;
  let from = Math.max(0, start - 56);
  let to = Math.min(text.length, end + 88);
  // Shrink only the outer context edges: keep the original window budgets.
  if (cutsPair(from)) from++;
  if (cutsPair(to)) to--;
  return { before: text.slice(from, start), after: text.slice(end, to) };
}
