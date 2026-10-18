/** Batch display notifications, never the ordered event mutations themselves. */
export class ThreadNotifications {
  private listeners = new Map<string, Map<() => void, { count: number }>>();
  private versions = new Map<string, number>();
  private revision = 0;
  private pending = new Set<string>();
  private frame: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  version(key: string): number {
    // Unsubscribed views still detect a change between render and subscribe.
    return this.versions.get(key) ?? this.revision;
  }

  subscribe(key: string, fn: () => void): () => void {
    let listeners = this.listeners.get(key);
    if (!listeners) {
      this.listeners.set(key, (listeners = new Map()));
      this.versions.set(key, this.revision);
    }
    let entry = listeners.get(fn);
    if (!entry) listeners.set(fn, (entry = { count: 0 }));
    entry.count++;
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      if (--entry.count === 0) listeners.delete(fn);
      if (!listeners.size && this.listeners.get(key) === listeners) {
        this.listeners.delete(key);
        this.versions.delete(key);
      }
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
    const revision = ++this.revision;
    const listeners = this.listeners.get(key);
    if (!listeners) return;
    this.versions.set(key, revision);
    // Newly subscribed callbacks belong to the next update, not this traversal.
    for (const [fn, entry] of [...listeners])
      if (this.listeners.get(key) === listeners && listeners.get(fn) === entry)
        fn();
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
    if (!keys.size) this.revision++;
    for (const key of keys) this.notify(key);
  }
}
