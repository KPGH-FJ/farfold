import {
  startHostShadow,
  type HostResumeCursor,
  type HostShadowHandle,
  type HostShadowState,
} from "./host-shadow";

type Start = (
  onState: (state: HostShadowState) => void,
  cursor?: HostResumeCursor,
) => Promise<HostShadowHandle>;

/** One workspace owns the channel; adapters only consume its published events. */
export class HostWorkspaceConnection {
  private handle: HostShadowHandle | null = null;
  private disposed = false;
  private reconnecting = false;
  private starting = false;

  constructor(
    private readonly onState: (state: HostShadowState) => void,
    private readonly onUnavailable: () => void,
    private readonly startChannel: Start = (onState, cursor) =>
      startHostShadow(onState, undefined, cursor),
  ) {}

  async start(cursor?: HostResumeCursor): Promise<HostShadowHandle> {
    if (this.disposed) throw new Error("Host workspace has closed.");
    if (this.handle || this.starting) {
      throw new Error("Host workspace channel is already owned.");
    }
    this.starting = true;
    try {
      const handle = await this.startChannel((state) => {
        if (!this.disposed) this.onState(state);
      }, cursor);
      if (this.disposed) {
        await handle.stop();
        throw new Error("Host workspace closed while connecting.");
      }
      this.handle = handle;
      return handle;
    } catch (reason) {
      if (!this.disposed) this.onUnavailable();
      throw reason;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.disposed = true;
    const handle = this.handle;
    this.handle = null;
    await handle?.stop();
  }

  /** QA-only pause/replay. Native operations remain supplied by the adapter. */
  async reconnectForQa(
    operation: () => Promise<void>,
  ): Promise<HostShadowState> {
    if (this.disposed || !this.handle || this.reconnecting) {
      throw new Error("Host Channel 尚未就绪或正在重新连接。");
    }
    this.reconnecting = true;
    const handle = this.handle;
    const snapshot = handle.snapshot();
    const cursor = {
      streamId: snapshot.streamId,
      latestSequence: snapshot.latestSequence,
    };
    try {
      await handle.stop();
      this.handle = null;
      try {
        await operation();
      } finally {
        if (!this.disposed) await this.start(cursor);
      }
      if (!this.handle) throw new Error("Host workspace closed during replay.");
      return (this.handle as HostShadowHandle).snapshot();
    } finally {
      this.reconnecting = false;
    }
  }
}
