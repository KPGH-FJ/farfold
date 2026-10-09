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
  const starts: number[] = [];
  let total = 0;
  for (const text of segments) {
    starts.push(total);
    total += text.length;
  }
  return textMatchOffsets(segments.join(""), query)
    .map((offset) => {
      const end = offset + query.trim().length;
      const startIndex = starts.findIndex(
        (start, index) =>
          offset >= start && offset < start + segments[index].length,
      );
      const endIndex = starts.findIndex(
        (start, index) => end > start && end <= start + segments[index].length,
      );
      return {
        startIndex,
        startOffset: offset - starts[startIndex],
        endIndex,
        endOffset: end - starts[endIndex],
      };
    })
    .filter((match) => match.startIndex >= 0 && match.endIndex >= 0);
}
