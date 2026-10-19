/** Match only loaded text. Each occurrence is a navigable location. */
export function textMatchOffsets(text: string, query: string): number[] {
  const needle = query.trim();
  if (!needle) return [];
  // RegExp indices belong to the original UTF-16 string. Lowercasing the
  // complete text first can change its length (for example Turkish capital İ).
  const literal = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(literal, "giu"))].map(
    (match) => match.index,
  );
}

/** Map text matches across inline formatting without inserting DOM wrappers. */
export function segmentedMatches(segments: readonly string[], query: string) {
  const starts = [0];
  let total = 0;
  for (const text of segments) {
    total += text.length;
    starts.push(total);
  }
  // Literal matches arrive in order with the same nonzero UTF-16 width. Each
  // cursor crosses a segment boundary at most once, including empty segments.
  const count = segments.length;
  const width = query.trim().length;
  let startCursor = 0;
  let endCursor = 0;
  return textMatchOffsets(segments.join(""), query)
    .map((offset) => {
      const end = offset + width;
      while (startCursor < count && offset >= starts[startCursor + 1])
        startCursor++;
      // End boundaries belong to the preceding nonempty text node.
      while (endCursor < count && end > starts[endCursor + 1]) endCursor++;
      const startIndex = startCursor < count ? startCursor : -1;
      const endIndex = endCursor < count ? endCursor : -1;
      return {
        startIndex,
        startOffset: offset - starts[startIndex],
        endIndex,
        endOffset: end - starts[endIndex],
      };
    })
    .filter((match) => match.startIndex >= 0 && match.endIndex >= 0);
}
