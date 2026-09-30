/** Owns a single login terminal across async startup, cancellation and exit. */
export class LoginTerminal {
  private starting: Promise<string> | null = null;
  private id: string | null = null;
  private closing: Promise<void> | null = null;
  private waiting: Promise<number> | null = null;
  private closeRequested = false;
  private finished = false;
  private disposed = false;

  constructor(
    private readonly ports: {
      start: () => Promise<string>;
      wait: (id: string) => Promise<number>;
      close: (id: string) => Promise<number | null>;
      ready: (id: string) => void;
      exit: (code: number, cancelled: boolean) => void;
      error: (reason: unknown) => void;
    },
  ) {}

  start(): Promise<string> {
    if (this.starting) return this.starting;
    this.starting = this.ports.start().then((id) => {
      if (!id) throw new Error("终端未能启动");
      this.id = id;
      if (!this.disposed) this.ports.ready(id);
      this.waiting = this.ports.wait(id);
      void this.waiting.then(
        (code) => this.finish(code),
        (reason) => {
          // A confirmed close may consume the backend owner before wait starts.
          // close() supplies confirmation; a standalone wait error is not exit.
          if (!this.closeRequested && !this.disposed) this.ports.error(reason);
        },
      );
      return id;
    });
    return this.starting;
  }

  private finish(code: number) {
    if (this.finished) return;
    this.finished = true;
    if (!this.disposed) this.ports.exit(code, this.closeRequested);
  }

  close(): Promise<void> {
    this.closeRequested = true;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const id = this.id ?? (await this.start());
      if (this.finished) return;
      const code = await this.ports.close(id);
      // If await already consumed the owner, its response still carries the
      // actual exit code. Never manufacture a failed exit for a late success.
      const actual = code ?? (await this.waiting);
      if (actual === null) throw new Error("终端退出结果尚未确认");
      this.finish(actual);
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  dispose() {
    this.disposed = true;
    void this.close().catch(() => {
      // The backend keeps an unconfirmed child registered and keeps reaping it.
      // No successful exit is synthesized when the UI has gone away.
    });
  }
}

export interface LoginOutput {
  sequence: number;
  data: string;
}
export interface LoginTerminalSnapshot {
  id: string | null;
  output: readonly LoginOutput[];
  error: unknown;
  exit: number | null;
  cancelled: boolean;
  closing: boolean;
}

/** Application-memory terminal owner; attaching a view never starts a process. */
export class BufferedLoginTerminal {
  private listeners = new Set<() => void>();
  private sequence = 0;
  private bytes = 0;
  private value: LoginTerminalSnapshot = {
    id: null,
    output: [],
    error: null,
    exit: null,
    cancelled: false,
    closing: false,
  };
  private owner: LoginTerminal;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.value;
  private update(patch: Partial<LoginTerminalSnapshot>) {
    this.value = { ...this.value, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  constructor(ports: {
    start: (output: (data: string) => void) => Promise<string>;
    wait: (id: string) => Promise<number>;
    close: (id: string) => Promise<number | null>;
    exit: (code: number, cancelled: boolean) => void;
  }) {
    this.owner = new LoginTerminal({
      start: () =>
        ports.start((data) => {
          const output = [
            ...this.value.output,
            { sequence: ++this.sequence, data },
          ];
          this.bytes += data.length;
          while (this.bytes > 512 * 1024 && output.length > 1) {
            this.bytes -= output.shift()!.data.length;
          }
          this.update({ output });
        }),
      wait: ports.wait,
      close: ports.close,
      ready: (id) => this.update({ id }),
      exit: (exit, cancelled) => {
        this.update({ exit, cancelled, closing: false });
        ports.exit(exit, cancelled);
      },
      error: (error) => this.update({ error }),
    });
  }
  start() {
    return this.owner.start();
  }
  async close() {
    this.update({ closing: true, error: null });
    try {
      await this.owner.close();
    } catch (error) {
      // Startup cancellation is a confirmed no-terminal result, not an unknown
      // close. Never hide a failure once an actual terminal id was received.
      if (
        !this.value.id &&
        String(error).replace(/^Error:\s*/, "") === "AUTH_CANCELLED"
      ) {
        this.update({ error: null, closing: false });
        return;
      }
      this.update({ error, closing: false });
      throw error;
    }
  }
}
