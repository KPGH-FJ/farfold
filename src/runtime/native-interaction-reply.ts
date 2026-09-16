// Presentation bookkeeping only. The Host registry validates native identity,
// expiry and reply types; this fence prevents stale callbacks changing the UI.
export class NativeInteractionReply {
  private scope: string | null = null;
  private pending: symbol | null = null;
  error: string | null = null;

  reconcile(scope: string | null): void {
    if (scope !== this.scope) {
      this.pending = null;
      this.error = null;
    }
    this.scope = scope;
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  async reply(
    send: () => Promise<unknown>,
    accepted: () => void,
    failed: (message: string) => void,
    changed: () => void,
  ): Promise<void> {
    if (!this.scope || this.pending) return;
    const token = Symbol("native interaction reply");
    this.pending = token;
    this.error = null;
    changed();
    let delivered = false;
    try {
      await send();
      if (this.pending === token) {
        delivered = true;
        accepted();
      }
    } catch (reason) {
      if (this.pending === token) {
        this.error = String(reason);
        failed(this.error);
      }
    } finally {
      if (this.pending === token && !delivered) {
        this.pending = null;
        changed();
      }
    }
  }
}
