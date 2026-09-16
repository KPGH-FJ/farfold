// UI request bookkeeping only. Native execution events own task termination.
export class NativeStopRequest {
  private scope: string | null = null;
  private working = false;
  private pending: symbol | null = null;

  reconcile(scope: string | null, working: boolean) {
    if (scope !== this.scope || !working) this.pending = null;
    this.scope = scope;
    this.working = working;
  }

  get stopping() {
    return this.working && this.pending !== null;
  }

  async request(
    send: () => Promise<unknown>,
    changed: () => void,
    failed: (message: string) => void,
  ) {
    if (!this.scope || !this.working || this.pending) return;
    const token = Symbol("stop request");
    this.pending = token;
    changed();
    try {
      if ((await send()) === false)
        throw new Error("Runtime 未接受停止请求，当前结果尚未确认。");
      // Acknowledgement is not confirmation of termination.
    } catch (reason) {
      if (this.pending !== token) return;
      this.pending = null;
      changed();
      failed(`停止尚未确认：${String(reason)}`);
    }
  }
}
