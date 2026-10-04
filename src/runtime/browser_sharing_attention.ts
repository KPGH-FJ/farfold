/** A volatile projection of actual browser decisions, never a second approval queue.
 * Only task/request identifiers leave the controller; no page or permission survives disposal.
 */
export class BrowserSharingAttention {
  private readonly entries = new Map<
    string,
    { owner: object; requestId: string }
  >();
  private readonly listeners = new Set<(taskKey: string) => void>();

  subscribe = (listener: (taskKey: string) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  pendingRequestId = (taskKey: string): string | null =>
    this.entries.get(taskKey)?.requestId ?? null;

  /** Controller-owned publishing; an old cleanup cannot remove a newer owner. */
  update(owner: object, taskKey: string, requestId: string | null) {
    if (!taskKey) return;
    if (!requestId) {
      this.release(owner, taskKey);
      return;
    }
    const previous = this.entries.get(taskKey);
    this.entries.set(taskKey, { owner, requestId });
    if (previous?.requestId !== requestId) this.changed(taskKey);
  }
  release(owner: object, taskKey: string) {
    if (this.entries.get(taskKey)?.owner !== owner) return;
    this.entries.delete(taskKey);
    this.changed(taskKey);
  }
  private changed(taskKey: string) {
    this.listeners.forEach((listener) => listener(taskKey));
  }
}

export const browserSharingAttention = new BrowserSharingAttention();
