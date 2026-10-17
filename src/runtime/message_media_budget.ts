/** Limits admitted file bytes and live message preview instances. This is not
 * a bound on codec pixels, animation frames, duration or transport memory. */
export const MAX_ACTIVE_MESSAGE_MEDIA = 4;
export const MAX_ACTIVE_MESSAGE_MEDIA_BYTES = 32 * 1024 * 1024;

export interface MessageMediaLease {
  release(): void;
}

/** No queue, eviction or subscriber: releasing another owner's lease must
 * never automatically load a previously refused preview. */
export class MessageMediaBudget {
  private readonly leases = new Map<symbol, number>();
  private bytes = 0;

  acquire(bytes: number): MessageMediaLease | null {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > MAX_ACTIVE_MESSAGE_MEDIA_BYTES ||
      this.leases.size >= MAX_ACTIVE_MESSAGE_MEDIA ||
      this.bytes + bytes > MAX_ACTIVE_MESSAGE_MEDIA_BYTES
    )
      return null;
    const id = Symbol();
    this.leases.set(id, bytes);
    this.bytes += bytes;
    return {
      release: () => {
        const owned = this.leases.get(id);
        if (owned === undefined) return;
        this.leases.delete(id);
        this.bytes -= owned;
      },
    };
  }
}

// One JavaScript workbench, across messages and conversations. Nothing is
// persisted, and no source payload or Agent state is stored in this pool.
export const messageMediaBudget = new MessageMediaBudget();
