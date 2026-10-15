import type {
  BrowserWorkspaceInvoke,
  BrowserWorkspaceState,
} from "./browser_workspace";
import type { IndexRow } from "./sessions";
import type { ThreadState } from "./session_types";
import { uiError } from "./ui_error";
import { REMEMBERED_BROWSER_STRINGS as S } from "./browser_remembered_strings";

export interface RememberedBrowserOwner {
  /** Existing Farfold conversation index row, not an external conversation id. */
  sessionId: string;
  createdAt: number;
}
export interface RememberedBrowserPage {
  id: string;
  url: string;
}
export interface RememberedBrowserList {
  owner: RememberedBrowserOwner;
  revision: number;
  items: RememberedBrowserPage[];
}
export interface RememberedBrowserOpen {
  owner: RememberedBrowserOwner;
  expectedRevision: number;
  itemId: string;
}
export interface RememberedBrowserPagesClient {
  list(input: {
    owner: RememberedBrowserOwner;
  }): Promise<RememberedBrowserList>;
  remember(input: {
    owner: RememberedBrowserOwner;
    expectedRevision: number;
    label: string;
    pageRevision: number;
    confirmedUrl: string;
  }): Promise<RememberedBrowserList>;
  forget(input: {
    owner: RememberedBrowserOwner;
    expectedRevision: number;
    itemId: string | null;
  }): Promise<RememberedBrowserList>;
}

export function createRememberedBrowserPagesClient(
  invoke: BrowserWorkspaceInvoke,
): RememberedBrowserPagesClient {
  return {
    list: (input) => invoke("browser_pages_list", input),
    remember: (input) => invoke("browser_pages_remember", input),
    forget: (input) => invoke("browser_pages_forget", input),
  };
}

export function sameRememberedOwner(
  a: RememberedBrowserOwner,
  b: RememberedBrowserOwner,
) {
  return a.sessionId === b.sessionId && a.createdAt === b.createdAt;
}

/** Consume a real matching row; never synthesize a persistent owner for a draft. */
export function ownerForRememberedPages(
  thread: Pick<
    ThreadState,
    "identity" | "key" | "agentId" | "cwd" | "nativeSessionId"
  >,
  row: IndexRow | undefined,
): RememberedBrowserOwner | null {
  return thread.identity === "established" &&
    row?.id === thread.key &&
    row.agentId === thread.agentId &&
    row.cwd === thread.cwd &&
    row.nativeSessionId === thread.nativeSessionId &&
    Number.isSafeInteger(row.createdAt)
    ? { sessionId: row.id, createdAt: row.createdAt }
    : null;
}

/** UX eligibility only; the backend separately checks the actual destination. */
export function rememberablePage(page: BrowserWorkspaceState | null) {
  if (
    !page ||
    page.phase !== "ready" ||
    page.localFileName !== undefined ||
    page.previewMode
  )
    return false;
  try {
    const url = new URL(page.url);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !!host &&
      host !== "localhost" &&
      !host.endsWith(".localhost") &&
      !host.endsWith(".local") &&
      !host.includes(":") &&
      !/^\d+(?:\.\d+){0,3}$/.test(host)
    );
  } catch {
    return false;
  }
}

export interface RememberedBrowserSnapshot {
  list: RememberedBrowserList;
  ready: boolean;
  busy: "load" | "remember" | "forget" | null;
  error: "" | "load" | "unknown";
  message: string;
}

/** Metadata only. Reads never open a page; writes are explicit and never retried. */
export class RememberedBrowserPages {
  private epoch = 0;
  private retired = true;
  private listeners = new Set<() => void>();
  private state: RememberedBrowserSnapshot;
  constructor(
    readonly client: RememberedBrowserPagesClient,
    readonly owner: RememberedBrowserOwner,
  ) {
    this.state = {
      list: { owner: { ...owner }, revision: 0, items: [] },
      ready: false,
      busy: null,
      error: "",
      message: "",
    };
  }
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<RememberedBrowserSnapshot>) {
    if (this.retired) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private accept(list: RememberedBrowserList) {
    if (
      !sameRememberedOwner(list.owner, this.owner) ||
      !Number.isSafeInteger(list.revision) ||
      list.revision < this.state.list.revision ||
      !Array.isArray(list.items) ||
      list.items.some((item) => !item.id || typeof item.url !== "string") ||
      new Set(list.items.map((item) => item.id)).size !== list.items.length
    )
      throw new Error("Invalid remembered-page list");
    this.publish({
      list: structuredClone(list),
      ready: true,
      error: "",
      message: "",
    });
  }
  start() {
    this.retired = false;
    ++this.epoch;
    // A preceding StrictMode effect can leave a retired read in flight.
    this.publish({ busy: null });
    return this.refresh();
  }
  retire() {
    this.retired = true;
    ++this.epoch;
  }
  async refresh() {
    if (this.retired || this.state.busy) return;
    const epoch = ++this.epoch;
    this.publish({ busy: "load" });
    try {
      const list = await this.client.list({ owner: { ...this.owner } });
      if (!this.retired && epoch === this.epoch) this.accept(list);
    } catch (failure) {
      if (!this.retired && epoch === this.epoch)
        this.publish({
          ready: false,
          error: "load",
          message: uiError(failure, S.loadFailed),
        });
    } finally {
      if (!this.retired && epoch === this.epoch) this.publish({ busy: null });
    }
  }
  private async change(
    kind: "remember" | "forget",
    execute: (expectedRevision: number) => Promise<RememberedBrowserList>,
  ) {
    if (
      this.retired ||
      !this.state.ready ||
      this.state.busy ||
      this.state.error
    )
      return false;
    const epoch = ++this.epoch;
    this.publish({ busy: kind });
    try {
      const list = await execute(this.state.list.revision);
      if (this.retired || epoch !== this.epoch) return false;
      this.accept(list);
      return true;
    } catch (failure) {
      if (!this.retired && epoch === this.epoch)
        this.publish({
          ready: false,
          error: "unknown",
          message: uiError(failure, S.unknown),
        });
      return false;
    } finally {
      if (!this.retired && epoch === this.epoch) this.publish({ busy: null });
    }
  }
  remember(page: BrowserWorkspaceState) {
    if (page.taskKey !== this.owner.sessionId || !rememberablePage(page))
      return Promise.resolve(false);
    return this.change("remember", (expectedRevision) =>
      this.client.remember({
        owner: { ...this.owner },
        expectedRevision,
        label: page.label,
        pageRevision: page.revision,
        confirmedUrl: page.url,
      }),
    );
  }
  forget(itemId: string | null) {
    return this.change("forget", (expectedRevision) =>
      this.client.forget({
        owner: { ...this.owner },
        expectedRevision,
        itemId,
      }),
    );
  }
  opening(itemId: string): RememberedBrowserOpen | null {
    if (
      this.retired ||
      !this.state.ready ||
      this.state.busy ||
      this.state.error ||
      !this.state.list.items.some((item) => item.id === itemId)
    )
      return null;
    return {
      owner: { ...this.owner },
      expectedRevision: this.state.list.revision,
      itemId,
    };
  }
}
