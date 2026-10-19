/** Yield between finite batches of the existing history consumer. This is a
 * work-scheduling limit, never a body limit or a delivery acknowledgement.
 * A single conversion may still take unbounded work for a large event. */
export async function consumeHistoryEvents(
  events: Iterable<unknown>,
  consume: (event: unknown) => void,
): Promise<void> {
  let count = 0;
  for (const event of events) {
    consume(event);
    if (++count === 32) {
      count = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}
