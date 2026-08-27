export function appendBounded<T>(
  current: readonly T[],
  value: T,
  limit: number,
): T[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Event buffer limit must be a positive integer");
  }
  return [...current.slice(-(limit - 1)), value];
}
