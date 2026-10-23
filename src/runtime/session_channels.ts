import { Channel } from "@tauri-apps/api/core";

/** Owns only local delivery. Retirement never cancels external Agent work. */
export class OwnedSessionChannel extends Channel<unknown> {
  private retireDelivery?: () => void;
  constructor(delivery: { dispose(): void }) {
    super();
    this.retireDelivery = () => delivery.dispose();
  }
  dispose(): void {
    const retire = this.retireDelivery;
    this.retireDelivery = undefined;
    this.onmessage = () => {};
    retire?.();
  }
}

/** The map is the existing live-view owner, with one retirement boundary for
 * normal close, connection loss, replacement, deletion and clearing. */
export class SessionChannels extends Map<string, OwnedSessionChannel> {
  override set(key: string, channel: OwnedSessionChannel): this {
    const previous = this.get(key);
    super.set(key, channel);
    if (previous !== channel) previous?.dispose();
    return this;
  }
  override delete(key: string): boolean {
    const previous = this.get(key);
    const deleted = super.delete(key);
    previous?.dispose();
    return deleted;
  }
  override clear(): void {
    const previous = [...this.values()];
    super.clear();
    for (const channel of previous) channel.dispose();
  }
}
