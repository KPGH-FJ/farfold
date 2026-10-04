/** CSS pixels relative to the main window's client area; never multiply by DPR. */
export interface BrowserWorkspaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserWorkspaceIdentity {
  taskKey: string;
  label: string;
}

export interface BrowserWorkspaceState extends BrowserWorkspaceIdentity {
  url: string;
  phase: "loading" | "ready" | "blocked" | "error" | "closed";
  revision: number;
  /** Diagnostic only. Do not render arbitrary backend errors or page content as UI. */
  error?: string;
}

export interface BrowserWorkspaceSnapshot extends BrowserWorkspaceIdentity {
  url: string;
  title: string;
  text: string;
  observedAtMs: number;
  revision: number;
}

export interface BrowserWorkspaceClient {
  open(input: {
    taskKey: string;
    url: string;
    bounds: BrowserWorkspaceBounds;
  }): Promise<BrowserWorkspaceState>;
  navigate(
    input: BrowserWorkspaceIdentity & { url: string },
  ): Promise<BrowserWorkspaceState>;
  resize(
    input: BrowserWorkspaceIdentity & { bounds: BrowserWorkspaceBounds },
  ): Promise<void>;
  snapshot(input: BrowserWorkspaceIdentity): Promise<BrowserWorkspaceSnapshot>;
  close(input: BrowserWorkspaceIdentity): Promise<unknown>;
  /** Subscribe only to the trusted main webview's browser-workspace:state event. */
  listenState(
    listener: (state: BrowserWorkspaceState) => void,
  ): Promise<() => void>;
}

export type BrowserWorkspaceInvoke = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;

/** Pass the existing trusted invoke/listen wrappers at the composition boundary. */
export function createBrowserWorkspaceClient(
  invoke: BrowserWorkspaceInvoke,
  listenState: BrowserWorkspaceClient["listenState"],
): BrowserWorkspaceClient {
  return {
    open: (input) => invoke("browser_workspace_open", input),
    navigate: (input) => invoke("browser_workspace_navigate", { ...input }),
    resize: (input) => invoke("browser_workspace_resize", { ...input }),
    snapshot: (input) => invoke("browser_workspace_snapshot", { ...input }),
    close: (input) => invoke("browser_workspace_close", { ...input }),
    listenState,
  };
}

export class BrowserWorkspaceRetiredError extends Error {}

/**
 * Owns only a live native surface identity, never page text or persistent state.
 * Closing waits for an in-flight open so even a late-created child is closed.
 * A successor cannot open until its predecessor confirms closure.
 */
export class BrowserWorkspaceScope {
  private state: BrowserWorkspaceState | null = null;
  private opening: Promise<BrowserWorkspaceState> | null = null;
  private closing: Promise<void> | null = null;
  private retired = false;
  private readonly pendingStates = new Map<string, BrowserWorkspaceState>();

  constructor(
    readonly client: BrowserWorkspaceClient,
    readonly taskKey: string,
    private readonly predecessor?: BrowserWorkspaceScope,
  ) {}

  get current(): BrowserWorkspaceState | null {
    return this.state;
  }

  get isRetired(): boolean {
    return this.retired;
  }

  accept(next: BrowserWorkspaceState): boolean {
    const current = this.state;
    if (
      !this.retired &&
      !current &&
      this.opening &&
      next.taskKey === this.taskKey
    ) {
      const previous = this.pendingStates.get(next.label);
      if (!previous || next.revision >= previous.revision) {
        this.pendingStates.set(next.label, next);
      }
      return false;
    }
    if (
      this.retired ||
      !current ||
      next.taskKey !== this.taskKey ||
      next.label !== current.label ||
      next.revision < current.revision
    ) {
      return false;
    }
    this.state = next;
    return true;
  }

  private identity(): BrowserWorkspaceIdentity {
    if (this.retired || !this.state || this.state.phase === "closed") {
      throw new BrowserWorkspaceRetiredError();
    }
    return { taskKey: this.taskKey, label: this.state.label };
  }

  async open(url: string, bounds: BrowserWorkspaceBounds) {
    if (this.retired || this.opening || this.state) {
      throw new BrowserWorkspaceRetiredError();
    }
    // Reserve synchronously, including the wait for a preceding instance.
    const opening = Promise.resolve().then(async () => {
      await this.predecessor?.close();
      if (this.retired) throw new BrowserWorkspaceRetiredError();
      const state = await this.client.open({
        taskKey: this.taskKey,
        url,
        bounds,
      });
      if (state.taskKey !== this.taskKey || !state.label) {
        throw new Error("Invalid browser workspace owner");
      }
      const event = this.pendingStates.get(state.label);
      this.state = event && event.revision > state.revision ? event : state;
      return this.state;
    });
    this.opening = opening;
    try {
      const state = await opening;
      if (this.retired) throw new BrowserWorkspaceRetiredError();
      return state;
    } finally {
      this.opening = null;
      this.pendingStates.clear();
    }
  }

  async navigate(url: string) {
    const state = await this.client.navigate({ ...this.identity(), url });
    const identity = this.identity();
    if (state.taskKey !== identity.taskKey || state.label !== identity.label) {
      throw new BrowserWorkspaceRetiredError();
    }
    this.accept(state);
    return this.state!;
  }

  async resize(bounds: BrowserWorkspaceBounds) {
    await this.client.resize({ ...this.identity(), bounds });
  }

  async snapshot() {
    const identity = this.identity();
    const startRevision = this.state?.revision;
    if (this.state?.phase !== "ready") {
      throw new BrowserWorkspaceRetiredError();
    }
    const result = await this.client.snapshot(identity);
    if (
      this.retired ||
      result.taskKey !== identity.taskKey ||
      result.label !== identity.label ||
      result.revision !== startRevision ||
      this.state?.revision !== startRevision ||
      this.state.phase !== "ready"
    ) {
      throw new BrowserWorkspaceRetiredError();
    }
    return result;
  }

  close(): Promise<void> {
    this.retired = true;
    if (this.closing) return this.closing;
    const closing = (async () => {
      // Also drain an earlier close when this scope never opened anything.
      await this.predecessor?.close();
      try {
        await this.opening;
      } catch {
        // An unsuccessful open has no surface; a successful late open sets state.
      }
      const state = this.state;
      if (state) {
        await this.client.close({ taskKey: this.taskKey, label: state.label });
        this.state = null;
      }
    })();
    this.closing = closing;
    void closing.catch(() => {
      // Preserve the identity and allow a later explicit action to retry closing.
      if (this.closing === closing) this.closing = null;
    });
    return closing;
  }
}

/** UX validation only. Backend must independently enforce public destinations. */
export function publicBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function browserWorkspaceBounds(
  rect: Pick<DOMRect, "x" | "y" | "width" | "height">,
): BrowserWorkspaceBounds | null {
  const { x, y, width, height } = rect;
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1
  ) {
    return null;
  }
  return { x, y, width, height };
}
