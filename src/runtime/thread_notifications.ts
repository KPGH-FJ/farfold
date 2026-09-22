/** Batch display notifications, never the ordered event mutations themselves. */
export class ThreadNotifications {
  private listeners = new Map<string, Set<() => void>>();
  private versions = new Map<string, number>();
  private pending = new Set<string>();
  private frame: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  subscribe(key: string, fn: () => void): () => void {
    let listeners = this.listeners.get(key);
    if (!listeners) this.listeners.set(key, (listeners = new Set()));
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  schedule(key: string): void {
    this.pending.add(key);
    if (this.timer !== null) return;
    // Hidden WebViews may suspend rAF; settlement/approvals still flush directly.
    this.timer = setTimeout(() => this.flushPending(), 32);
    if (typeof requestAnimationFrame === "function")
      this.frame = requestAnimationFrame(() => this.flushPending());
  }

  private cancelScheduled(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.frame !== null && typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(this.frame);
    this.timer = null;
    this.frame = null;
  }

  private notify(key: string): void {
    this.versions.set(key, this.version(key) + 1);
    for (const fn of this.listeners.get(key) ?? []) fn();
  }

  private flushPending(): void {
    this.cancelScheduled();
    const keys = [...this.pending];
    this.pending.clear();
    for (const key of keys) this.notify(key);
  }

  /** Semantic events publish immediately; metadata refreshes notify all views. */
  flush(key?: string): void {
    if (key !== undefined) {
      this.pending.delete(key);
      if (!this.pending.size) this.cancelScheduled();
      this.notify(key);
      return;
    }
    const keys = new Set([...this.pending, ...this.listeners.keys()]);
    this.pending.clear();
    this.cancelScheduled();
    for (const key of keys) this.notify(key);
  }
}
