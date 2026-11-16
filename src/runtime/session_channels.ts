import { Channel } from "@tauri-apps/api/core";
import { confirmSavedConfiguration } from "./saved_configuration_restore";
import type { ThreadState } from "./session_types";

/** Owns only local delivery. Retirement never cancels external Agent work. */
export class OwnedSessionChannel extends Channel<unknown> {
  private retireDelivery?: () => void;
  private settleDelivery?: (deadline: number) => Promise<void>;
  constructor(delivery: {
    dispose(): void;
    settle?(deadline: number): Promise<void>;
  }) {
    super();
    this.retireDelivery = () => delivery.dispose();
    this.settleDelivery = delivery.settle?.bind(delivery);
  }
  settle(deadline: number): Promise<void> {
    return (
      this.settleDelivery?.(deadline) ??
      Promise.reject(new Error("delivery unavailable"))
    );
  }
  dispose(): void {
    const retire = this.retireDelivery;
    this.retireDelivery = undefined;
    this.settleDelivery = undefined;
    this.onmessage = () => {};
    retire?.();
  }
}

/** The map is the existing live-view owner, with one retirement boundary for
 * normal close, connection loss, replacement, deletion and clearing. */
export class SessionChannels extends Map<string, OwnedSessionChannel> {
  /** The exact existing view owns both the command and its delivery barrier. */
  confirmRestored(
    key: string,
    selection: Record<string, unknown>,
    hooks: { current(): ThreadState | undefined; emit(): void },
  ): Promise<void> {
    const channel = this.get(key);
    return confirmSavedConfiguration(hooks.current(), selection, {
      ...hooks,
      current: () => (this.get(key) === channel ? hooks.current() : undefined),
      settleDelivery: async (deadline) => {
        if (!channel || this.get(key) !== channel)
          throw new Error("delivery owner changed");
        await channel.settle(deadline);
        if (this.get(key) !== channel)
          throw new Error("delivery owner changed");
      },
    });
  }
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
